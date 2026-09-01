/**
 * Verify that every known `@appstrate/core` consumer is in lockstep with
 * the version about to be published. Run by `.github/workflows/publish-core.yml`
 * before npm publish — failing here forces a consumer bump pass before a new
 * core version goes out.
 *
 * Drift policy:
 *   - major mismatch      → fail (block publish), EXCEPT one major behind on an
 *                           X.0.0 release, which is a warning — see `assessDrift`.
 *   - >= 2 minors behind  → fail (block publish).
 *   - 1 minor behind      → warn.
 *   - in sync             → OK.
 *
 * Override via env: `CONSUMER_DRIFT_POLICY=warn|fail|off`.
 */

interface Consumer {
  /** GitHub repo in `owner/repo` form. */
  repo: string;
  /** package.json paths within the repo. */
  paths: string[];
}

/**
 * Every repo outside this monorepo that resolves `@appstrate/core` from npm.
 *
 * A repo missing from this list is invisible to the gate and drifts silently.
 * That is not a hypothetical — it is why the list exists: `connect-helper` and
 * the then-standalone `appstrate/module-claude-code` were both absent, and
 * `module-claude-code` sat on `^2.19.0` — three majors behind — still
 * declaring `ModelProviderDefinition.oauthWireFormat`, a field core had
 * removed in 3.0.0. Nobody noticed until someone read its `package.json` by
 * hand.
 *
 * That anecdote is now history: PR #460 (2026-05-14) moved the module in-tree
 * as `packages/module-claude-code`, and the standalone repo is dead. It is
 * therefore NOT in the list below, per rule 3. `registry` and `portal` left the
 * list the same way and for the same reason — not absorbed, retired.
 *
 * The rule, in three parts:
 *
 *   1. A repo OUTSIDE this monorepo that resolves `@appstrate/core` from npm
 *      belongs here — that is the entire membership test.
 *   2. A package INSIDE this monorepo never does. It resolves `workspace:*`
 *      (see `packages/module-claude-code/package.json`) and cannot drift, so
 *      listing it would gate the publish on a version that does not exist.
 *   3. A repo that STOPS consuming core from npm must be REMOVED here, in the
 *      same pass that stops it — whether it was absorbed in-tree, retired or
 *      archived. Its default branch keeps whatever range it last published
 *      forever, and nothing consumes it any more — so leaving it in reports a
 *      permanent failure that no bump anywhere can clear.
 */
const CONSUMERS: Consumer[] = [
  { repo: "appstrate/cloud", paths: ["package.json"] },
  // Published to npm (public package, private source repo) — installed by
  // end users via `npx`, so a stale core range ships to them directly.
  { repo: "appstrate/connect-helper", paths: ["package.json"] },
];

const DEPENDENCY_NAME = "@appstrate/core";

type DriftPolicy = "warn" | "fail" | "off";
const VALID_POLICIES: readonly DriftPolicy[] = ["warn", "fail", "off"];

/**
 * Resolve the drift policy from the environment. An unset value defaults to the
 * strictest (`fail`). An *unrecognized* value (typo, wrong case like `FAIL`)
 * must NOT silently disable blocking — fall back to `fail` with a warning so a
 * misconfigured env can never fail open.
 */
export function resolvePolicy(raw: string | undefined): DriftPolicy {
  if (raw === undefined) return "fail";
  if ((VALID_POLICIES as readonly string[]).includes(raw)) return raw as DriftPolicy;
  console.warn(
    `Unrecognized CONSUMER_DRIFT_POLICY="${raw}" — expected one of ${VALID_POLICIES.join("|")}. Defaulting to "fail".`,
  );
  return "fail";
}

const POLICY = resolvePolicy(process.env.CONSUMER_DRIFT_POLICY);

function parseSemver(v: string): [number, number, number] | null {
  const cleaned = v.replace(/^[\^~>=<\s]+/, "").trim();
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(cleaned);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

export type DriftVerdict = "ok" | "warn" | "fail";

export interface DriftAssessment {
  verdict: DriftVerdict;
  /** Trailing half of the log line, printed after `<repo>/<path> pins <range> — `. */
  detail: string;
}

/**
 * Decide how bad one consumer's declared range is against the version being
 * published. Pure — the caller owns fetching, policy and reporting.
 */
export function assessDrift(
  local: [number, number, number],
  consumer: [number, number, number],
): DriftAssessment {
  const [lMaj, lMin, lPatch] = local;
  const [cMaj, cMin] = consumer;
  const localLabel = local.join(".");

  if (cMaj !== lMaj) {
    const isMajorRelease = lMin === 0 && lPatch === 0;
    const oneMajorBehind = cMaj === lMaj - 1;
    // A consumer CANNOT declare `^X.0.0` before X.0.0 exists on npm — its own
    // CI runs `bun install --frozen-lockfile`, which cannot resolve an
    // unpublished version. So at an X.0.0 release, "exactly one major behind"
    // is the only state a consumer can possibly be in, and failing it made
    // every major publish impossible without disabling the whole gate via
    // CONSUMER_DRIFT_POLICY (issue #1028). Tolerated here and only here: the
    // next release of that major is not itself a major, so an unbumped
    // consumer fails hard the very next time core publishes.
    if (isMajorRelease && oneMajorBehind) {
      return {
        verdict: "warn",
        detail:
          `1 major behind ${localLabel} — expected during a major release, since the ` +
          `range cannot be declared before this publish. Bump the consumer to ^${lMaj}.0.0 ` +
          `right after; it will fail this gate on the next core release.`,
      };
    }
    return { verdict: "fail", detail: `major mismatch with ${localLabel}` };
  }

  const minorDelta = lMin - cMin;
  if (minorDelta >= 2) {
    return { verdict: "fail", detail: `${minorDelta} minors behind ${localLabel}` };
  }
  if (minorDelta === 1) {
    return { verdict: "warn", detail: `1 minor behind ${localLabel}` };
  }
  if (compare(consumer, local) < 0) {
    return { verdict: "ok", detail: "patch-behind, OK" };
  }
  return { verdict: "ok", detail: "in sync" };
}

/**
 * Assess a consumer's declared range. A range that cannot be parsed is also a
 * consumer that cannot be verified, so it follows the active enforcement
 * policy instead of disappearing from the summary.
 */
export function assessDeclaredRange(
  local: [number, number, number],
  range: string,
  policy: Exclude<DriftPolicy, "off">,
): DriftAssessment {
  const consumer = parseSemver(range);
  if (!consumer) {
    return {
      verdict: policy === "fail" ? "fail" : "warn",
      detail: `unparsable range "${range}", cannot verify drift`,
    };
  }
  return assessDrift(local, consumer);
}

/**
 * Read one consumer's `package.json` from GitHub.
 *
 * Throws on ANY non-2xx, 404 included. That is the whole point: a 404 here is
 * never "the file is absent". Every repo in {@link CONSUMERS} is a live npm
 * package and therefore has a `package.json` — so a 404 means the READ failed,
 * which for a private repo means the token cannot see it.
 *
 * Returning null on 404 is what let the gate report `Summary: 0 failure(s)`
 * while verifying nothing: `CONSUMER_LOCKSTEP_TOKEN` was present but could not
 * read either private consumer, both 404'd, both were logged as
 * "not present, skipping", and core@6.1.0 published unverified. The caller
 * already fails closed on fetch errors — 404 now takes that same path instead
 * of routing around it.
 */
export async function fetchPackageJson(
  repo: string,
  path: string,
): Promise<Record<string, unknown>> {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    "User-Agent": "appstrate-consumer-version-check",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    // GitHub returns 404 rather than 403 for a repo the token cannot see, so
    // it does not leak the repo's existence. Name that here: the message is
    // the operator's only clue, and "404 Not Found" alone reads as "the file
    // was deleted" — sending them to look in the wrong place.
    const authHint = token
      ? ` Check that CONSUMER_LOCKSTEP_TOKEN still has contents:read on ${repo}` +
        ` (expired PAT, missing scope, repository not selected, or SSO not authorized).`
      : ` GITHUB_TOKEN is not configured. Configure it with a token that has contents:read on ${repo};` +
        ` the publish-core workflow sources GITHUB_TOKEN from the repository secret CONSUMER_LOCKSTEP_TOKEN.`;
    const hint =
      res.status === 404
        ? ` — a listed consumer always has this file, so this is a READ failure, not an absent file.` +
          authHint +
          ` If the repo genuinely stopped consuming @appstrate/core, remove it from CONSUMERS instead.`
        : "";
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}${hint}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  if (POLICY === "off") {
    console.log("CONSUMER_DRIFT_POLICY=off — skipping check.");
    return;
  }

  const localPkg = await Bun.file("packages/core/package.json").json();
  const localVersion = parseSemver(String(localPkg.version));
  if (!localVersion) {
    console.error(`Cannot parse local @appstrate/core version: ${localPkg.version}`);
    process.exit(1);
  }
  const [lMaj, lMin] = localVersion;
  console.log(`Publishing @appstrate/core@${lMaj}.${lMin}.${localVersion[2]}`);
  console.log("");

  let warnings = 0;
  let failures = 0;

  for (const consumer of CONSUMERS) {
    for (const path of consumer.paths) {
      let pkg: Record<string, unknown>;
      try {
        pkg = await fetchPackageJson(consumer.repo, path);
      } catch (err) {
        // Fail closed: a fetch error (404/403/rate-limit/outage) means we could
        // NOT verify this consumer. Under `fail` policy that is a blocking
        // failure — otherwise a transient GitHub error would let core publish
        // without ever checking its consumers. `warn`/`off` may still bypass.
        //
        // 404 reaches here too, deliberately. It used to return null and get
        // logged as "not present, skipping", which is how a token that could
        // read neither private consumer still produced `0 failure(s)`.
        const detail = err instanceof Error ? err.message : String(err);
        if (POLICY === "fail") {
          console.error(`  ✗ ${consumer.repo}/${path} — fetch failed, cannot verify (${detail})`);
          failures++;
        } else {
          console.warn(`  ! ${consumer.repo}/${path} — fetch failed (${detail})`);
          warnings++;
        }
        continue;
      }

      // `peerDependencies` is inspected too, and it is LOAD-BEARING, not
      // speculative: `cloud` declares `@appstrate/core` under
      // `peerDependencies` ONLY (the host platform supplies it, and the range
      // is exactly the compatibility claim the module makes to operators). It
      // appears in neither `dependencies` nor `devDependencies`, so this
      // spread is the only thing that verifies half the consumer list — drop
      // it and the gate reports `cloud` as "does not depend on
      // @appstrate/core" and passes.
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
        ...(pkg.peerDependencies as Record<string, string> | undefined),
      };
      const range = deps[DEPENDENCY_NAME];
      if (!range) {
        console.log(`  - ${consumer.repo}/${path} — does not depend on ${DEPENDENCY_NAME}`);
        continue;
      }

      const { verdict, detail } = assessDeclaredRange(localVersion, range, POLICY);
      const line = `${consumer.repo}/${path} pins ${range} — ${detail}`;
      if (verdict === "fail") {
        console.error(`  ✗ ${line}`);
        failures++;
      } else if (verdict === "warn") {
        console.warn(`  ! ${line}`);
        warnings++;
      } else {
        console.log(`  ✓ ${line}`);
      }
    }
  }

  console.log("");
  console.log(`Summary: ${failures} failure(s), ${warnings} warning(s)`);

  if (failures > 0 && POLICY === "fail") {
    console.error("");
    console.error("Bump the failing consumers to match before publishing core.");
    process.exit(1);
  }
}

// Guarded so tests can import this script without hitting the GitHub API.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}
