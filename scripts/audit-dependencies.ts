#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Known-vulnerability gate — fails on an un-allowlisted `high` or `critical`
 * advisory against the committed `bun.lock`.
 *
 * Dependabot/Renovate already open PRs for vulnerable dependencies, but nothing
 * in this repo FAILED on one: a CVE could sit in `bun.lock` indefinitely and
 * every pipeline stayed green. This closes that, and only that.
 *
 * ─── Why `bun audit`, and not a scanner ──────────────────────────────
 *
 * `bun.lock` is the only statement of this repo's resolved tree, and Bun reads
 * it natively. osv-scanner and the Go/Rust scanners want a lockfile format they
 * understand; buying one would mean also committing a second, generated
 * lockfile — a file that can go stale against the real one, in silence, in the
 * direction that reports fewer packages.
 *
 * ─── Why this is NOT in `bun run check` ──────────────────────────────
 *
 * `bun run check` is the `pre-push` hook. `bun audit` posts the lockfile's
 * package set to the npm bulk-advisory endpoint, so wiring it into `check`
 * would make every push require the network and fail on a plane. It runs as a
 * CI job instead (`.github/workflows/security.yml`), and `bun run audit:deps`
 * runs the identical check locally.
 *
 * ─── What `bun audit --json` actually emits ──────────────────────────
 *
 * Measured 2026-09-07 against this lockfile (`bun audit v1.3.11`; CI pins
 * 1.3.14 via `.github/actions/bun-setup`). Four properties this file depends
 * on, none of them guessed:
 *
 *   1. stdout is a flat map, `{"<package>": [advisory, …], …}`, and an
 *      advisory carries `id`, `url`, `title`, `severity`, `vulnerable_versions`,
 *      `cwe`, `cvss`. There is no envelope, no `metadata`, no installed
 *      version — so an allowlist entry can only be keyed on package + id.
 *   2. The exit code is 1 whenever ANY advisory exists, at any severity. It is
 *      therefore not a verdict this gate can reuse: a tree whose only finding
 *      is one `low` advisory exits 1 exactly like a tree with a critical. The
 *      exit code is ignored below and the JSON is the sole input.
 *   3. `--audit-level` and `--ignore` do NOT filter `--json` output.
 *      `bun audit --json --audit-level=critical --ignore=GHSA-w7jw-789q-3m8p`
 *      printed all 66 advisories, `low` ones included. Every severity and
 *      allowlist decision has to be made here; do not reach for those flags on
 *      the theory that they narrow the payload.
 *   4. No `node_modules` is required. `package.json` + `bun.lock` copied alone
 *      into an empty directory produced a byte-identical 20-package report, so
 *      the CI job skips `bun install`.
 *
 * ─── The knob ────────────────────────────────────────────────────────
 *
 * `DEPENDENCY_AUDIT_POLICY=warn|fail|off`, through the shared
 * `readGatePolicy` — which rejects any other value rather than degrading to
 * "print the findings and exit 0", and pins the policy to `fail` under CI so a
 * green pipeline cannot be bought by exporting `off`.
 *
 * Usage: bun scripts/audit-dependencies.ts
 */

import { join } from "node:path";
import { readGatePolicy } from "./lib/policy-env.ts";

/** The severities the npm advisory feed emits, ordered least to most severe. */
const SEVERITIES = ["low", "moderate", "high", "critical"] as const;

export type Severity = (typeof SEVERITIES)[number];

/**
 * The severities that fail this gate.
 *
 * `high` is where CVSS v3 crosses 7.0, which is the line at which an advisory
 * is expected to be acted on as its own piece of work rather than batched into
 * the next dependency sweep. Below it, the npm feed's volume is the dominant
 * term: 28 of the 66 advisories on this lockfile are moderate or low
 * (measured 2026-09-07), and blocking on them would make the gate's verdict
 * track the advisory database's publishing rate rather than this repo's risk —
 * a red that arrives on a morning nobody changed anything is a red people learn
 * to clear rather than read.
 *
 * They are not dropped: `reviewAdvisories` counts every severity and
 * `summaryLine` prints all four, so a moderate becoming a high, or the moderate
 * count doubling, is visible in the success line of a passing run.
 */
const FATAL_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(["high", "critical"]);

/** One advisory, flattened out of the per-package map with its package name. */
export interface Advisory {
  /** npm package the advisory is against, i.e. the map key it came from. */
  packageName: string;
  /** GitHub advisory database numeric id — `bun audit`'s `id`, unique per range. */
  id: number;
  severity: Severity;
  title: string;
  url: string;
  /** The affected range, verbatim (`<7.5.5`, `>=2.0.0 <2.1.3`). */
  vulnerableVersions: string;
}

/**
 * A fatal advisory this repo accepts for now, with the date the acceptance
 * stops being true.
 *
 * Checked in BOTH directions by `reviewAdvisories`, the rule
 * `ACCEPTED_CROSS_MODULE_IMPORTS` in `verify-module-isolation.ts` carries for
 * the same reason: an entry that no longer matches a live FATAL advisory fails
 * the gate, so this cannot quietly become a list of vulnerabilities that were
 * patched two releases ago while reading like a list of live risks.
 *
 * `expires` is enforcement, not documentation. An entry past its date fails the
 * gate on its own — that is the whole point of writing one down. Accepting a
 * CVE is a decision with a shelf life ("upstream has no fix yet", "the call
 * path is unreachable from our code"), and the only mechanism that reliably
 * forces the re-decision is the gate going red on the day the acceptance
 * expired. The date is inclusive: the gate is still green ON `expires`.
 *
 * `reason` is prose and must say why the risk is accepted, not what the
 * advisory is — the advisory says that, and `url` links it.
 */
export interface AcceptedAdvisory {
  id: number;
  packageName: string;
  reason: string;
  /** `YYYY-MM-DD`. Malformed values throw — see `parseExpiry`. */
  expires: string;
}

/**
 * Reasons that are one situation shared by many advisories, named once.
 *
 * Twelve `fast-uri` advisories and nine `brace-expansion` ones are the same
 * dependency edge reported per affected range; writing the edge out twelve
 * times would make a change to it twelve edits, eleven of which get missed.
 */
const REASONS = {
  /**
   * Both installed copies are in the product tree, and the SSRF question the
   * advisory class raises is answered somewhere else entirely.
   *
   * Established 2026-09-07, not assumed. `bun.lock` holds fast-uri@3.1.0 (via
   * `ajv`, a direct dependency of `packages/core` and `apps/api`) and
   * fast-uri@4.1.1 (via `@rjsf/utils`, a direct dependency of `apps/web` and
   * `packages/ui`). In both, fast-uri parses JSON-Schema `$id`/`$ref` URIs — it
   * never decides an egress destination. The egress guard that does
   * (`packages/afps-shared/src/ssrf.ts`, `ssrf-dns.ts`) depends on neither:
   * afps-shared's whole dependency set is `fflate`, `semver`, `yaml`, and the
   * guard resolves addresses with `node:net`'s `isIP` and `node:dns`. No file
   * in this repo imports `fast-uri` directly.
   */
  fastUri:
    "Product tree, both copies (ajv ← packages/core + apps/api; @rjsf/utils ← apps/web + " +
    "packages/ui), but only for JSON-Schema $id/$ref parsing. The SSRF-guarded egress path " +
    "(afps-shared ssrf.ts) does not depend on fast-uri — it uses node:net/node:dns.",

  /**
   * `@google/genai` is an optional peer of `@earendil-works/pi-ai` and is
   * imported by pi-ai only on the Google provider path. Nothing in this repo
   * imports it (grepped 2026-09-07), but Google IS a selectable model provider
   * (`apps/api/src/data/pricing/google-ai.json`, `featured-models.json`), so
   * the code loads whenever a run picks a Gemini model. Conditionally
   * reachable, therefore treated as product code.
   */
  googleGenai:
    "Product tree via @google/genai ← @earendil-works/pi-ai. Loaded only when a run selects a " +
    "Google model; no in-repo import of @google/genai.",
} as const;

/**
 * Seeded 2026-09-07 as a day-one baseline, NOT as a clean bill of health.
 *
 * The gate landed on a lockfile that already carried 38 high/critical
 * advisories. An empty list would have meant a gate red from its first run,
 * which is a gate people learn to ignore; a list with no expiry dates would
 * have meant a permanent amnesty. So every advisory live on the day the gate
 * landed is written down here with the dependency edge that produces it and a
 * date, and **the gate's job from now on is to fail on anything NEW** — a
 * newly published advisory, or a new dependency that drags an old one in, has
 * no entry and stops the build.
 *
 * The dates are the mechanism that keeps this from being an amnesty. The
 * backlog gets worked because the gate goes red on `expires + 1` and somebody
 * has to either upgrade the dependency or write down a reason that is still
 * true. Two tiers, and the split is the reachability finding, not a guess:
 *
 *   - `2026-10-31` — the package is in the PRODUCT dependency tree.
 *   - `2026-12-31` — dev/build tree only, or installed-but-never-imported.
 *
 * One live advisory is deliberately NOT here: `better-auth` 1124302 (account
 * takeover via pre-account hijacking on magic-link and email-OTP sign-in). It
 * is a direct dependency, magic-link is an enabled auth path, and its
 * remediation is being decided separately. The gate is red on exactly that one
 * advisory, and that is the intended state.
 *
 * `bun update` was verified NOT to move any of this (same 66/38 before and
 * after): these are pinned by transitive semver ranges, and forcing them with
 * root `overrides` is a separate change with its own blast radius.
 */
const ACCEPTED_ADVISORIES: AcceptedAdvisory[] = [
  // ── brace-expansion — three installed copies, two of them dev-only ──
  // 1.1.15 via eslint-plugin-react → minimatch.
  {
    id: 1123897,
    packageName: "brace-expansion",
    reason: "Dev tree only — brace-expansion@1.1.15 via minimatch ← eslint-plugin-react.",
    expires: "2026-12-31",
  },
  {
    id: 1130588,
    packageName: "brace-expansion",
    reason: "Dev tree only — brace-expansion@1.1.15 via minimatch ← eslint-plugin-react.",
    expires: "2026-12-31",
  },
  {
    id: 1130737,
    packageName: "brace-expansion",
    reason: "Dev tree only — brace-expansion@1.1.15 via minimatch ← eslint-plugin-react.",
    expires: "2026-12-31",
  },
  // 2.1.1 via openapi-typescript → @redocly/openapi-core → minimatch.
  {
    id: 1123896,
    packageName: "brace-expansion",
    reason:
      "Dev tree only — brace-expansion@2.1.1 via minimatch ← @redocly/openapi-core ← " +
      "openapi-typescript.",
    expires: "2026-12-31",
  },
  {
    id: 1130589,
    packageName: "brace-expansion",
    reason:
      "Dev tree only — brace-expansion@2.1.1 via minimatch ← @redocly/openapi-core ← " +
      "openapi-typescript.",
    expires: "2026-12-31",
  },
  {
    id: 1130736,
    packageName: "brace-expansion",
    reason:
      "Dev tree only — brace-expansion@2.1.1 via minimatch ← @redocly/openapi-core ← " +
      "openapi-typescript.",
    expires: "2026-12-31",
  },
  // 5.0.5 via @earendil-works/pi-coding-agent → minimatch. Product.
  {
    id: 1123898,
    packageName: "brace-expansion",
    reason:
      "Product tree — brace-expansion@5.0.5 via minimatch ← @earendil-works/pi-coding-agent. " +
      "Glob patterns come from agent/skill config, not from request input; DoS only.",
    expires: "2026-10-31",
  },
  {
    id: 1130591,
    packageName: "brace-expansion",
    reason:
      "Product tree — brace-expansion@5.0.5 via minimatch ← @earendil-works/pi-coding-agent. " +
      "Glob patterns come from agent/skill config, not from request input; DoS only.",
    expires: "2026-10-31",
  },
  {
    id: 1130734,
    packageName: "brace-expansion",
    reason:
      "Product tree — brace-expansion@5.0.5 via minimatch ← @earendil-works/pi-coding-agent. " +
      "Glob patterns come from agent/skill config, not from request input; DoS only.",
    expires: "2026-10-31",
  },

  // ── browserslist ──
  {
    id: 1153171,
    packageName: "browserslist",
    reason:
      "Dev tree only — @babel/helper-compilation-targets ← @babel/core ← " +
      "eslint-plugin-react-hooks. Runs under eslint, never in a shipped bundle.",
    expires: "2026-12-31",
  },
  {
    id: 1153172,
    packageName: "browserslist",
    reason:
      "Dev tree only — @babel/helper-compilation-targets ← @babel/core ← " +
      "eslint-plugin-react-hooks. The untrusted browserslist-stats.json the advisory needs is " +
      "not a file this repo has.",
    expires: "2026-12-31",
  },

  // ── defu ──
  {
    id: 1116102,
    packageName: "defu",
    reason:
      "Product tree — sole consumer is better-auth, which uses defu to merge its own option " +
      "objects. Whether any request-controlled value reaches that merge is NOT established; " +
      "short expiry for that reason.",
    expires: "2026-10-31",
  },

  // ── fast-uri — 12 advisories, one dependency situation ──
  { id: 1124064, packageName: "fast-uri", reason: REASONS.fastUri, expires: "2026-10-31" },
  { id: 1130719, packageName: "fast-uri", reason: REASONS.fastUri, expires: "2026-10-31" },
  { id: 1130720, packageName: "fast-uri", reason: REASONS.fastUri, expires: "2026-10-31" },
  { id: 1145559, packageName: "fast-uri", reason: REASONS.fastUri, expires: "2026-10-31" },
  { id: 1153168, packageName: "fast-uri", reason: REASONS.fastUri, expires: "2026-10-31" },
  { id: 1158520, packageName: "fast-uri", reason: REASONS.fastUri, expires: "2026-10-31" },
  { id: 1158523, packageName: "fast-uri", reason: REASONS.fastUri, expires: "2026-10-31" },
  { id: 1158524, packageName: "fast-uri", reason: REASONS.fastUri, expires: "2026-10-31" },
  { id: 1158526, packageName: "fast-uri", reason: REASONS.fastUri, expires: "2026-10-31" },
  { id: 1158529, packageName: "fast-uri", reason: REASONS.fastUri, expires: "2026-10-31" },
  { id: 1158530, packageName: "fast-uri", reason: REASONS.fastUri, expires: "2026-10-31" },
  { id: 1182133, packageName: "fast-uri", reason: REASONS.fastUri, expires: "2026-10-31" },

  // ── ip-address ──
  {
    id: 1130722,
    packageName: "ip-address",
    reason:
      "Installed but the vulnerable path is not imported: sole consumer is express-rate-limit " +
      "inside @modelcontextprotocol/sdk. This platform serves MCP over the SDK's Web-standard " +
      "transport (apps/api/src/modules/mcp/router.ts) and rate-limits with " +
      "rate-limiter-flexible — no Express middleware is loaded.",
    expires: "2026-12-31",
  },

  // ── js-yaml — only 4.1.1 is in range; 5.2.2 is not ──
  {
    id: 1123911,
    packageName: "js-yaml",
    reason:
      "Product tree — js-yaml@4.1.1 via @apidevtools/swagger-parser, a runtime dependency of " +
      "apps/cli (published). Parses OpenAPI documents the operator points the CLI at; " +
      "quadratic-CPU DoS only.",
    expires: "2026-10-31",
  },
  {
    id: 1138115,
    packageName: "js-yaml",
    reason:
      "Product tree — js-yaml@4.1.1 via @apidevtools/swagger-parser, a runtime dependency of " +
      "apps/cli (published). Parses OpenAPI documents the operator points the CLI at; " +
      "quadratic-CPU DoS only.",
    expires: "2026-10-31",
  },

  // ── nanoid ──
  {
    id: 1139427,
    packageName: "nanoid",
    reason:
      "Build tree only — the affected copy is nanoid@3.3.17 via postcss ← vite. The copy the " +
      "product uses is nanoid@6.0.0, outside the advisory's range.",
    expires: "2026-12-31",
  },

  // ── protobufjs — all six via the same optional Google provider path ──
  { id: 1117571, packageName: "protobufjs", reason: REASONS.googleGenai, expires: "2026-10-31" },
  { id: 1118641, packageName: "protobufjs", reason: REASONS.googleGenai, expires: "2026-10-31" },
  { id: 1118928, packageName: "protobufjs", reason: REASONS.googleGenai, expires: "2026-10-31" },
  { id: 1118930, packageName: "protobufjs", reason: REASONS.googleGenai, expires: "2026-10-31" },
  { id: 1118932, packageName: "protobufjs", reason: REASONS.googleGenai, expires: "2026-10-31" },
  { id: 1123488, packageName: "protobufjs", reason: REASONS.googleGenai, expires: "2026-10-31" },

  // ── shell-quote ──
  {
    id: 1120422,
    packageName: "shell-quote",
    reason:
      "Installed but unreachable — sole consumer is `gel` (the Gel/EdgeDB driver), an optional " +
      "peer of drizzle-orm. Nothing in this repo imports `gel` or `drizzle-orm/gel`; the " +
      "platform is on postgres.js.",
    expires: "2026-12-31",
  },
  {
    id: 1123944,
    packageName: "shell-quote",
    reason:
      "Installed but unreachable — sole consumer is `gel` (the Gel/EdgeDB driver), an optional " +
      "peer of drizzle-orm. Nothing in this repo imports `gel` or `drizzle-orm/gel`; the " +
      "platform is on postgres.js.",
    expires: "2026-12-31",
  },

  // ── ws ──
  { id: 1123259, packageName: "ws", reason: REASONS.googleGenai, expires: "2026-10-31" },
];

/** Advisory counts by severity, plus the three verdict counts. */
export interface AuditCounts {
  inspected: number;
  packages: number;
  bySeverity: Record<Severity, number>;
  allowlisted: number;
  fatal: number;
  /**
   * Allowlist entries matching no live fatal advisory. A separate count, not
   * folded into `fatal`, and the distinction is the whole reason it exists.
   *
   * The stale-entry pass used to push a problem and increment nothing, so a
   * tree whose only finding was a rotted allowlist printed `… 0 allowlisted,
   * 0 fatal.` and exited 1 — a summary line identical to a clean run's, on a
   * red gate, which is precisely the defect the rest of this file is written
   * against. Adding it to `fatal` would have fixed the arithmetic and told a
   * different lie: bookkeeping rot is not a live vulnerability, and a summary
   * claiming a CVE that is not in the tree sends somebody hunting for it.
   */
  staleAcceptances: number;
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

/**
 * `bun audit --json` stdout → a flat advisory list.
 *
 * Every shape deviation throws rather than being skipped. A parser that
 * `continue`s past an entry it does not recognise reports a smaller population
 * with the same cheerful summary line, which is the one failure this gate
 * cannot survive: its output would be indistinguishable from a clean tree.
 *
 * That includes an unrecognised `severity`. Bucketing an unknown severity as
 * non-fatal would hide it; bucketing it as fatal would red-flag a benign feed
 * addition. Refusing to run is the same answer `readGatePolicy` gives to an
 * unrecognised policy value, and it puts the decision in front of a human once
 * rather than silently every run after.
 */
export function parseAuditReport(raw: string): Advisory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `bun audit did not emit JSON on stdout. It exits non-zero whenever advisories exist, so a ` +
        `non-zero exit alone is not the problem — an empty or non-JSON stdout means the command ` +
        `itself failed (no lockfile, registry unreachable). First 200 chars: ` +
        `${JSON.stringify(raw.slice(0, 200))}`,
      { cause },
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(
      `bun audit --json must emit an object keyed by package name; got ${
        Array.isArray(parsed) ? "an array" : typeof parsed
      }. The payload shape changed — read it before adapting this parser.`,
    );
  }

  const advisories: Advisory[] = [];

  for (const [packageName, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      throw new TypeError(
        `bun audit --json: value for package \`${packageName}\` is not an array of advisories.`,
      );
    }
    for (const entry of list) {
      if (entry === null || typeof entry !== "object") {
        throw new TypeError(`bun audit --json: \`${packageName}\` holds a non-object advisory.`);
      }
      const row = entry as Record<string, unknown>;
      if (typeof row["id"] !== "number") {
        throw new TypeError(`bun audit --json: \`${packageName}\` advisory has no numeric \`id\`.`);
      }
      if (!isSeverity(row["severity"])) {
        throw new TypeError(
          `bun audit --json: \`${packageName}\` advisory ${row["id"]} has severity ` +
            `${JSON.stringify(row["severity"])}, which is not one of ${SEVERITIES.join(", ")}. ` +
            `Refusing to guess whether that is fatal — add the severity to SEVERITIES and decide ` +
            `whether it belongs in FATAL_SEVERITIES.`,
        );
      }
      advisories.push({
        packageName,
        id: row["id"],
        severity: row["severity"],
        title: typeof row["title"] === "string" ? row["title"] : "(no title)",
        url: typeof row["url"] === "string" ? row["url"] : "(no url)",
        vulnerableVersions:
          typeof row["vulnerable_versions"] === "string" ? row["vulnerable_versions"] : "(unknown)",
      });
    }
  }

  return advisories;
}

/**
 * `YYYY-MM-DD` → the same string, validated.
 *
 * Compared as text, not as `Date`s: both sides are zero-padded ISO dates, so
 * lexicographic order IS chronological order, and there is no timezone to get
 * wrong. `new Date("2026-09-07")` is midnight UTC, which in this repo's
 * timezone is the previous evening — an entry would expire a day early for
 * anyone west of Greenwich and on time in CI.
 */
function parseExpiry(entry: AcceptedAdvisory): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
    throw new TypeError(
      `ACCEPTED_ADVISORIES entry for \`${entry.packageName}\` advisory ${entry.id} has ` +
        `expires=${JSON.stringify(entry.expires)}, which is not a YYYY-MM-DD date.`,
    );
  }
  const asDate = new Date(`${entry.expires}T00:00:00Z`);
  if (Number.isNaN(asDate.getTime()) || asDate.toISOString().slice(0, 10) !== entry.expires) {
    throw new TypeError(
      `ACCEPTED_ADVISORIES entry for \`${entry.packageName}\` advisory ${entry.id} has ` +
        `expires=${JSON.stringify(entry.expires)}, which is not a real calendar date.`,
    );
  }
  return entry.expires;
}

/** What one review pass concluded. */
export interface AuditReview {
  problems: string[];
  counts: AuditCounts;
}

/**
 * Decide, for one audit's worth of advisories, what is fatal and which
 * acceptances have gone stale. Pure — the scan feeds it a real report,
 * `scripts/test/audit-dependencies.test.ts` feeds it fixtures.
 *
 * `today` is `YYYY-MM-DD` and is injected rather than read from the clock, so
 * the expiry cases are assertable without either freezing time or writing a
 * test that starts failing on a particular morning.
 *
 * The allowlist is consulted ONLY for fatal advisories, and that is what makes
 * an entry covering a `moderate` finding fail: it suppresses nothing, so it
 * matches nothing, so the stale-entry pass reports it. An acceptance that
 * grants no exemption is the same dead weight as one whose advisory is gone.
 *
 * An expired entry reports once, not twice. The expiry message already names
 * the package, the advisory and the fact that the gate is red because of it;
 * re-listing the advisory underneath as "un-allowlisted" would be two findings
 * for one decision and would read as two separate things to fix.
 */
export function reviewAdvisories(
  advisories: readonly Advisory[],
  accepted: readonly AcceptedAdvisory[],
  today: string,
): AuditReview {
  const problems: string[] = [];
  const matched = new Set<AcceptedAdvisory>();

  const bySeverity: Record<Severity, number> = { low: 0, moderate: 0, high: 0, critical: 0 };
  for (const a of advisories) bySeverity[a.severity]++;

  let allowlisted = 0;
  let fatal = 0;
  let staleAcceptances = 0;

  for (const advisory of advisories) {
    if (!FATAL_SEVERITIES.has(advisory.severity)) continue;

    const entry = accepted.find(
      (e) => e.id === advisory.id && e.packageName === advisory.packageName,
    );

    if (entry) {
      matched.add(entry);
      if (parseExpiry(entry) < today) {
        fatal++;
        problems.push(
          `ACCEPTED_ADVISORIES accepts ${advisory.severity} advisory ${advisory.id} in ` +
            `\`${advisory.packageName}\` until ${entry.expires}, and today is ${today}. ` +
            `The acceptance has run out: upgrade the dependency, or re-decide and set a new ` +
            `expires with a reason that is true today. ${advisory.url}`,
        );
        continue;
      }
      allowlisted++;
      continue;
    }

    fatal++;
    problems.push(
      `${advisory.severity} advisory ${advisory.id} in \`${advisory.packageName}\` ` +
        `(${advisory.vulnerableVersions}): ${advisory.title}. ` +
        `Upgrade the dependency, or add an ACCEPTED_ADVISORIES entry with a reason and an ` +
        `expires date. ${advisory.url}`,
    );
  }

  // Stale acceptance — an entry matching no live fatal advisory. It fails the
  // gate, but under its own count: an allowlist checked only in the "is it
  // still allowed" direction becomes a record of things fixed long ago, and
  // every entry in it then reads as a live accepted risk to whoever audits this
  // file next. See `AuditCounts.staleAcceptances` for why it is not `fatal`.
  for (const entry of accepted) {
    if (matched.has(entry)) continue;
    parseExpiry(entry);
    staleAcceptances++;
    problems.push(
      `ACCEPTED_ADVISORIES lists advisory ${entry.id} in \`${entry.packageName}\`, but no ` +
        `un-fixed high/critical advisory matches it any more. Delete the entry.`,
    );
  }

  return {
    problems,
    counts: {
      inspected: advisories.length,
      packages: new Set(advisories.map((a) => a.packageName)).size,
      bySeverity,
      allowlisted,
      fatal,
      staleAcceptances,
    },
  };
}

/** The one-line verdict, with the counts that distinguish it from a no-op run. */
export function summaryLine(counts: AuditCounts): string {
  const { bySeverity: s } = counts;
  return (
    `${counts.inspected} advisory(ies) across ${counts.packages} package(s) — ` +
    `${s.critical} critical, ${s.high} high, ${s.moderate} moderate, ${s.low} low; ` +
    `${counts.allowlisted} allowlisted, ${counts.fatal} fatal, ` +
    `${counts.staleAcceptances} stale allowlist entry(ies).`
  );
}

// Guarded so the tests can import the pure logic above without spawning
// `bun audit`, which needs the network and exits non-zero on any advisory.
if (import.meta.main) {
  // Default-secure (`fail`), pinned to `fail` under CI, and throws on any value
  // that is neither `warn`, `fail` nor `off` — see `scripts/lib/policy-env.ts`
  // for the incident that rule records.
  const POLICY = readGatePolicy("DEPENDENCY_AUDIT_POLICY");

  const run = Bun.spawnSync({
    cmd: ["bun", "audit", "--json"],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });

  // The exit code is deliberately not read: it is 1 for a single `low`
  // advisory just as it is for a critical (measured — see the header). A
  // failure of the COMMAND shows up as stdout that is not JSON, which
  // `parseAuditReport` throws on, naming the stderr it saw.
  const stdout = run.stdout.toString();
  if (stdout.trim() === "") {
    throw new Error(
      `bun audit produced no stdout (exit ${run.exitCode}). stderr: ` +
        `${run.stderr.toString().trim() || "(empty)"}`,
    );
  }

  const advisories = parseAuditReport(stdout);
  const today = new Date().toISOString().slice(0, 10);
  const { problems, counts } = reviewAdvisories(advisories, ACCEPTED_ADVISORIES, today);

  for (const p of problems) console.error(`❌ ${p}`);

  if (problems.length === 0) {
    console.log(`✅ dependency audit clean — ${summaryLine(counts)}`);
    for (const e of ACCEPTED_ADVISORIES) {
      console.log(`   accepted until ${e.expires}: ${e.packageName} ${e.id} — ${e.reason}`);
    }
  } else {
    console.error(`❌ dependency audit — ${summaryLine(counts)}`);
  }

  if (problems.length > 0 && POLICY === "fail") process.exit(1);
}
