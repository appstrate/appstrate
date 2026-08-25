// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

/**
 * lint-manifest-casing — repo-level grep lint for legacy camelCase manifest
 * keys leaking into writer contexts. Long-term safeguard against a writer
 * accidentally emitting `displayName: …` in newly-created manifest payloads:
 * AFPS manifests are canonical snake_case (`display_name`, `max_size`, …).
 *
 * Strategy — DISCOVERY, then subtract. Every tracked source file is scanned;
 * the two filters that keep the signal usable are the writer-shape requirement
 * and the exclusion list below, and both are narrow and argued.
 *
 * ─── Why discovery and not a scan list ───────────────────────────────
 *
 * This gate used to carry `SCAN_FILES`, 23 hand-written paths. An inclusion
 * list can only ever cover the files somebody remembered to add, and its
 * failure is silent in the direction that matters: a NEW manifest-writing file
 * is not scanned, and the gate prints `OK — (23 scan targets)`. The existence
 * guard added later only caught the opposite case — a listed path that
 * vanished. The discovery itself lives in `scripts/lib/tracked-files.ts`,
 * shared with `scripts/lint.ts` and `scripts/verify-compose-defaults.ts`, which
 * had each grown their own copy of it.
 *
 * The polarity is the whole point. Under discovery, a new AFPS writer is
 * covered the day it is committed, and the thing that now needs remembering is
 * an EXCLUSION — which fails loudly (a false positive in CI) rather than
 * quietly. A gate should err toward saying too much.
 *
 * ─── The three filters ───────────────────────────────────────────────
 *
 *  1. **Writer shape**: the key must appear as `<key>:` (object literal
 *     property, on its own line or wrapped by prettier onto the next) or
 *     `<obj>.<key> =` (manifest assignment) where `<obj>` is one of `manifest`,
 *     `finalManifest`, `m`, `payload`, `patch`, `wrapper`, or `output`. This
 *     catches the exact leak shape (`finalManifest.displayName = …`) without
 *     dragging in DB queries or React `Foo.displayName = "Foo"`.
 *
 *  2. **Per-line exemptions**: `// canonical-casing-exempt`, `// back-compat`,
 *     the cleanup pattern (`<key>: undefined` / `delete m.<key>`), and read
 *     fallback chains (`?? m.<key>`).
 *
 *  3. **`EXCLUDED_SCOPES`**: the measured inventory of places this repo
 *     legitimately spells one of these names in camelCase — Better Auth's
 *     `profiles.displayName`, model-provider and platform-MODULE descriptors,
 *     wire DTOs and React view models, `maxSize` as a byte limit,
 *     `runtimeTools` as a TS-internal field. Each entry is scoped to the KEYS
 *     it exempts, not to the whole file, and every entry is checked to still
 *     suppress something — see `EXCLUDED_SCOPES` for both rules.
 *
 * Exits non-zero on any hit. Wired into the root `check` script via the
 * `lint:manifest-casing` script in root package.json.
 */

import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { SOURCE_GLOBS, trackedFiles } from "./lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..");

// Banned legacy camelCase manifest keys — canonical AFPS form is snake_case.
const BANNED_KEYS = [
  "displayName",
  "schemaVersion",
  "fileConstraints",
  "uiHints",
  "propertyOrder",
  "maxSize",
  "iconUrl",
  "providersConfiguration",
  "runtimeTools",
] as const;

type BannedKey = (typeof BANNED_KEYS)[number];

/**
 * Where this repo legitimately spells one of the banned names in camelCase.
 *
 * Two rules make this list stay narrow, and both are enforced below rather
 * than asked for politely:
 *
 *   1. **Key-scoped, never file-scoped.** An entry exempts the listed `keys`
 *      and nothing else, so excluding `apps/api/src/modules/` for
 *      `displayName` does not also excuse a `fileConstraints:` leak in the
 *      same tree. A file-wide exclusion is how a subtraction list turns into
 *      the inclusion list this replaced, one file at a time.
 *
 *   2. **Must still suppress something.** `assertExclusionsAreLive()` fails
 *      the gate when an entry's path no longer produces the hit it was written
 *      for. That covers a deleted or renamed path (the case the old
 *      `existsSync` guard handled) AND the case it did not: code that was
 *      cleaned up, leaving an exclusion behind to quietly cover whatever lands
 *      at that path next.
 *
 * `path` is a repo-relative prefix — a file, or a directory ending in `/`.
 *
 * The five groups below are a measurement, not a judgement call: they are the
 * complete residue of running this gate over all tracked sources with only the
 * writer-shape and per-line filters (124 hits in 57 files, re-measured
 * 2026-08-25 with `excludedBy` stubbed to return nothing). Every one of them is camelCase that `docs/CASING_CONVENTIONS.md`
 * positively requires — not AFPS manifest keys wearing the wrong casing.
 */
interface ExcludedScope {
  path: string;
  keys: readonly BannedKey[];
  reason: string;
}

const PROFILE_DISPLAY_NAME =
  "`profiles.displayName` is a Better Auth-adjacent Drizzle column and a " +
  "universal DB-convention field: camelCase in the schema, on the wire and in the " +
  "SPA (docs/CASING_CONVENTIONS.md). It is a user's name, not an AFPS manifest key.";

const MODULE_DESCRIPTOR =
  "Platform MODULE + model-provider descriptors (`ModelProviderDescriptor`, a " +
  "module's own manifest). That contract is camelCase by policy — CLAUDE.md, " +
  '"module hooks, logger fields … camelCase" — and is a different document from ' +
  "an AFPS package manifest, which is the only thing this gate is about.";

const WIRE_DTO =
  "Platform wire DTO / React view model. These map FROM the canonical " +
  "`display_name` / `icon_url` (several do it on the same line) into TS-internal " +
  "camelCase, which is the documented direction of travel, not a leak.";

const BYTE_LIMIT =
  "`maxSize` here is a byte cap — Hono's body limit, the upload cap, an HTTP " +
  "response cap, the file widget's prop. It is an ordinary TS parameter name and " +
  "has nothing to do with the AFPS `max_size` file constraint.";

const RUNTIME_TOOLS_INTERNAL =
  "`runtimeTools` here is a TS-internal field of the runtime-tools catalog and of " +
  "the launcher plan/options objects, not the manifest's `runtime_tools` array.";

const EXCLUDED_SCOPES: readonly ExcludedScope[] = [
  // ── Group 1: the user's display name ──
  {
    path: "packages/db/src/schema/profiles.ts",
    keys: ["displayName"],
    reason: PROFILE_DISPLAY_NAME,
  },
  // Better Auth's `databaseHooks.user.create.after` seeds the profile row:
  // `displayName: user.name || user.email`. It was invisible until the
  // writer-shape regex stopped excusing every value that begins with `u` —
  // `user.name` did — so this entry is the one pre-existing occurrence that fix
  // surfaced, and it is the same Group 1 case as the rest.
  { path: "packages/db/src/auth.ts", keys: ["displayName"], reason: PROFILE_DISPLAY_NAME },
  { path: "apps/api/src/services/profile.ts", keys: ["displayName"], reason: PROFILE_DISPLAY_NAME },
  { path: "apps/api/src/routes/profile.ts", keys: ["displayName"], reason: PROFILE_DISPLAY_NAME },
  {
    path: "apps/api/src/openapi/paths/profile.ts",
    keys: ["displayName"],
    reason: PROFILE_DISPLAY_NAME,
  },
  {
    path: "apps/api/src/services/organizations.ts",
    keys: ["displayName"],
    reason: PROFILE_DISPLAY_NAME,
  },
  {
    path: "apps/api/src/routes/organizations.ts",
    keys: ["displayName"],
    reason: PROFILE_DISPLAY_NAME,
  },
  {
    path: "apps/api/src/openapi/paths/organizations.ts",
    keys: ["displayName"],
    reason: PROFILE_DISPLAY_NAME,
  },
  {
    path: "apps/api/src/services/api-keys.ts",
    keys: ["displayName"],
    reason: PROFILE_DISPLAY_NAME,
  },
  {
    path: "apps/api/src/services/invitations.ts",
    keys: ["displayName"],
    reason: PROFILE_DISPLAY_NAME,
  },
  { path: "apps/api/src/routes/packages.ts", keys: ["displayName"], reason: PROFILE_DISPLAY_NAME },
  { path: "apps/api/src/routes/welcome.ts", keys: ["displayName"], reason: PROFILE_DISPLAY_NAME },
  {
    path: "apps/api/src/openapi/paths/welcome.ts",
    keys: ["displayName"],
    reason: PROFILE_DISPLAY_NAME,
  },
  { path: "apps/web/src/hooks/use-auth.ts", keys: ["displayName"], reason: PROFILE_DISPLAY_NAME },
  {
    path: "apps/web/src/hooks/use-profile.ts",
    keys: ["displayName"],
    reason: PROFILE_DISPLAY_NAME,
  },
  {
    path: "apps/web/src/components/register-form.tsx",
    keys: ["displayName"],
    reason: PROFILE_DISPLAY_NAME,
  },
  {
    path: "apps/web/src/pages/preferences/general.tsx",
    keys: ["displayName"],
    reason: PROFILE_DISPLAY_NAME,
  },
  { path: "apps/web/src/pages/welcome.tsx", keys: ["displayName"], reason: PROFILE_DISPLAY_NAME },
  { path: "apps/cli/src/commands/whoami.ts", keys: ["displayName"], reason: PROFILE_DISPLAY_NAME },

  // ── Group 2: module + model-provider descriptors ──
  // `apps/api/src/modules/core-providers/index.ts` and NOT the directory it
  // sits in. The entry here used to read `apps/api/src/modules/` — a whole
  // subtree spanning five built-in modules — which is exactly the file-scoped
  // shape rule 1 above forbids, and it swallowed the leak this gate is named
  // after: injecting `finalManifest.displayName = …` into
  // `apps/api/src/modules/mcp/index.ts` gave `exit=0`, while the same line in
  // `apps/api/src/services/system-packages.ts` gave `exit=1`.
  //
  // The narrowing costs nothing, because the subtree was never carrying five
  // modules' worth of camelCase: with the directory entry removed, all 30 hits
  // under `apps/api/src/modules/` came from this ONE file (the 14
  // `ModelProviderDescriptor` literals), and `mcp`, `oidc`, `webhooks` and
  // `firecracker` contain zero occurrences of either key. A directory was
  // being excluded for a file.
  {
    path: "apps/api/src/modules/core-providers/index.ts",
    keys: ["displayName", "iconUrl"],
    reason: MODULE_DESCRIPTOR,
  },
  {
    path: "packages/module-claude-code/src/index.ts",
    keys: ["displayName", "iconUrl"],
    reason: MODULE_DESCRIPTOR,
  },
  {
    path: "packages/module-codex/src/index.ts",
    keys: ["displayName", "iconUrl"],
    reason: MODULE_DESCRIPTOR,
  },
  {
    path: "packages/core/src/module.ts",
    keys: ["displayName", "iconUrl"],
    reason: MODULE_DESCRIPTOR,
  },
  { path: "apps/api/src/services/model-registry.ts", keys: ["iconUrl"], reason: MODULE_DESCRIPTOR },
  { path: "apps/api/src/services/org-models.ts", keys: ["iconUrl"], reason: MODULE_DESCRIPTOR },
  { path: "apps/api/src/openapi/paths/models.ts", keys: ["iconUrl"], reason: MODULE_DESCRIPTOR },
  {
    path: "apps/api/src/openapi/paths/model-provider-credentials.ts",
    keys: ["displayName", "iconUrl"],
    reason: MODULE_DESCRIPTOR,
  },
  {
    path: "apps/api/src/routes/model-provider-credentials.ts",
    keys: ["displayName", "iconUrl"],
    reason: MODULE_DESCRIPTOR,
  },
  {
    path: "apps/web/src/components/credential-form-modal.tsx",
    keys: ["iconUrl"],
    reason: MODULE_DESCRIPTOR,
  },
  { path: "apps/web/src/components/icons.tsx", keys: ["iconUrl"], reason: MODULE_DESCRIPTOR },

  // ── Group 3: wire DTOs and view models ──
  { path: "apps/api/src/openapi/schemas.ts", keys: ["displayName", "iconUrl"], reason: WIRE_DTO },
  { path: "apps/api/src/services/me-connections.ts", keys: ["displayName"], reason: WIRE_DTO },
  { path: "apps/api/src/services/run-file-naming.ts", keys: ["displayName"], reason: WIRE_DTO },
  {
    path: "packages/shared-types/src/index.ts",
    keys: ["displayName", "iconUrl"],
    reason: WIRE_DTO,
  },
  // GENERATED file (scripts/generate-api-types.ts, from the OpenAPI spec), so
  // this entry is a tripwire on the spec rather than on hand-written code: the
  // day `icon_url` stops being spelled `iconUrl` in a response schema, the
  // regenerated client stops producing the hit and `deadExclusions` reports
  // this line. Delete it then — do not edit the generated file.
  { path: "apps/web/src/api/schema.d.ts", keys: ["iconUrl"], reason: WIRE_DTO },
  { path: "apps/web/src/components/editor-shell.tsx", keys: ["displayName"], reason: WIRE_DTO },
  { path: "apps/web/src/components/schedule-form.tsx", keys: ["displayName"], reason: WIRE_DTO },
  { path: "apps/web/src/components/package-detail/", keys: ["displayName"], reason: WIRE_DTO },
  { path: "apps/web/src/pages/dashboard.tsx", keys: ["displayName"], reason: WIRE_DTO },
  { path: "apps/web/src/pages/package-list.tsx", keys: ["displayName"], reason: WIRE_DTO },
  { path: "apps/web/src/pages/item-tab.tsx", keys: ["displayName"], reason: WIRE_DTO },
  { path: "apps/web/src/pages/integration-detail.tsx", keys: ["displayName"], reason: WIRE_DTO },
  { path: "apps/web/src/pages/schedule-create.tsx", keys: ["displayName"], reason: WIRE_DTO },
  {
    path: "apps/web/src/pages/preferences/connections.tsx",
    keys: ["displayName"],
    reason: WIRE_DTO,
  },

  // ── Group 4: `maxSize` as a byte cap ──
  { path: "apps/api/src/middleware/body-limit.ts", keys: ["maxSize"], reason: BYTE_LIMIT },
  {
    path: "apps/api/src/modules/firecracker/runner/server.ts",
    keys: ["maxSize"],
    reason: BYTE_LIMIT,
  },
  { path: "apps/api/src/services/uploads.ts", keys: ["maxSize"], reason: BYTE_LIMIT },
  {
    path: "packages/afps-runtime/src/resolvers/http-call-core.ts",
    keys: ["maxSize"],
    reason: BYTE_LIMIT,
  },
  { path: "packages/ui/src/schema-form/file-widget.tsx", keys: ["maxSize"], reason: BYTE_LIMIT },
  { path: "apps/web/src/hooks/use-schema-form-labels.ts", keys: ["maxSize"], reason: BYTE_LIMIT },

  // ── Group 5: `runtimeTools` as a TS-internal field ──
  {
    path: "packages/core/src/runtime-tools-catalog.ts",
    keys: ["displayName"],
    reason: RUNTIME_TOOLS_INTERNAL,
  },
  {
    path: "apps/api/src/services/run-launcher/pi.ts",
    keys: ["runtimeTools"],
    reason: RUNTIME_TOOLS_INTERNAL,
  },
  { path: "apps/cli/src/commands/run.ts", keys: ["runtimeTools"], reason: RUNTIME_TOOLS_INTERNAL },
  {
    path: "packages/runner-pi/src/runtime-tools/",
    keys: ["runtimeTools"],
    reason: RUNTIME_TOOLS_INTERNAL,
  },
  { path: "runtime-pi/entrypoint.ts", keys: ["runtimeTools"], reason: RUNTIME_TOOLS_INTERNAL },
  { path: "runtime-pi/sidecar/server.ts", keys: ["runtimeTools"], reason: RUNTIME_TOOLS_INTERNAL },
];

/** Is this (file, key) pair covered by a documented exclusion? */
function excludedBy(relPath: string, key: string): ExcludedScope | undefined {
  return EXCLUDED_SCOPES.find(
    (scope) => relPath.startsWith(scope.path) && (scope.keys as readonly string[]).includes(key),
  );
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.tsx") ||
    filePath.includes(`${sep}test${sep}`) ||
    filePath.includes(`${sep}tests${sep}`) ||
    filePath.includes(`${sep}__tests__${sep}`)
  );
}

// Per-line exemptions: legitimate read fallbacks and M8 cleanup writes.
//
// The four patterns below are BUILT from `BANNED_KEYS` rather than repeating
// its nine names inline four times, which is what they used to do. A key added
// to the list above but forgotten in one of these alternations would have been
// reported with none of its exemptions honoured — a false positive nobody could
// silence except by editing this file, which is the wrong way round.
const KEY_ALT = BANNED_KEYS.join("|");
const LINE_EXEMPTIONS: RegExp[] = [
  // Documented per-line opt-outs.
  /\/\/.*back-compat/i,
  // Explicit per-line opt-out tag for documented TS-internal carve-outs
  // (e.g. agent-editor `MetadataState`/`SchemaField` field names — these are
  // TS-internal state types per CASING_CONVENTIONS.md, not manifest wire keys;
  // they translate to canonical snake_case via `metadataToManifestPatch` /
  // `fieldsToSchema`).
  /\/\/.*canonical-casing-exempt\b/i,
  // Read fallback: `?? <obj>.<bannedKey>` (and `?? (<obj>.<bannedKey> as ...)`).
  new RegExp(`\\?\\?\\s*\\(?[\\w.\\[\\]'"\`]*\\.(${KEY_ALT})\\b`),
  // M8 cleanup: `displayName: undefined` — a documented writer-side strip of a
  // legacy sibling key.
  new RegExp(`\\b(${KEY_ALT})\\s*:\\s*undefined\\b`),
  // M8 cleanup: `delete m.runtimeTools`.
  new RegExp(`\\bdelete\\s+[\\w\\[\\]'"\`.()]+\\.(${KEY_ALT})\\b`),
  // `as { displayName?: … }` type-narrowing READS. The writer-shape regex below
  // filters most reads implicitly; this covers the cast form it cannot.
  new RegExp(`\\bas\\s*\\{[^}]*\\b(${KEY_ALT})\\b`),
];

function lineIsExempt(line: string): boolean {
  return LINE_EXEMPTIONS.some((re) => re.test(line));
}

interface Hit {
  file: string;
  line: number;
  text: string;
  key: string;
}

// Writer-shape regexes for a banned key. Matches either:
//   1. Object literal property:  `<key>: <something-not-undefined>`
//   2. Manifest field assignment: `<obj>.<key> = <value>` where <obj> is one
//      of manifest, finalManifest, m, payload, patch, wrapper, output, draft,
//      entry, manif, item.
//
// Two defects measured in the form this replaces, both against
// `apps/api/src/services/system-packages.ts` (a file no exclusion covers) with
// the control `displayName: "x"` reported on the same run:
//
//   - `[^u\s]` was a cheap stand-in for "not `undefined`", so it also excused
//     EVERY value beginning with `u`. `displayName: userName` — an ordinary
//     write of a variable — got `exit=0`. It is a negative lookahead now, which
//     costs nothing and means exactly what it says.
//   - a prettier-wrapped property (`displayName:` on one line, the value on the
//     next) matched nothing, because `\s*` cannot cross a line in a per-line
//     scan. `displayName:\n  someVeryLongExpression,` got `exit=0` too. Hence
//     `wrapped` below, which the caller pairs with the following line.
//
// `wrapped` is a SEPARATE anchored pattern rather than a two-line window fed to
// the same regex, on purpose: a window would also match a key that lives wholly
// on the second line, and that line's own window would match it again — one
// leak reported twice, at two line numbers. Requiring `<key>:` to be the last
// thing on the line matches the wrap and only the wrap.
interface WriterShape {
  /** The whole write is on one line. */
  same: RegExp;
  /** `<key>:` ends the line; the value is on the next one. */
  wrapped: RegExp;
}

function buildWriterShapeRegex(key: string): WriterShape {
  // Object-literal: `<key>:` not preceded by an alphanumeric (so we don't
  // match `someOtherDisplayName:`).
  // Assignment: `<obj>.<key> =` (not ==, not =>).
  const objNames = "(manifest|finalManifest|m|payload|patch|wrapper|output|draft|entry|manif|item)";
  const property = `(?:^|[^A-Za-z0-9_$])${key}\\s*:\\s*`;
  return {
    same: new RegExp(
      `(?:${property}(?!undefined\\b)\\S)|` +
        `(?:\\b${objNames}(?:\\.[A-Za-z0-9_$]+)*\\.${key}\\s*=(?!=|>))`,
    ),
    wrapped: new RegExp(`${property}$`),
  };
}

/**
 * Scan every tracked source file, returning the hits no exclusion covers, and
 * the (scope, key) pairs each exclusion actually suppressed.
 */
function scan(): { hits: Hit[]; suppressed: Set<string>; scanned: number } {
  const hits: Hit[] = [];
  const suppressed = new Set<string>();
  let scanned = 0;
  const keyPatterns = BANNED_KEYS.map((k) => ({ key: k, re: buildWriterShapeRegex(k) }));

  // `trackedFiles` already dropped the index entries whose file is gone from
  // the working tree (a `git rm` not yet committed, a refactor in flight), so
  // this read is plain: any failure here IS a broken checkout and must not be
  // swallowed — that is the class of silent skip this gate was rewritten to
  // remove.
  for (const rel of trackedFiles(SOURCE_GLOBS, "source file")) {
    if (isTestFile(rel)) continue;
    const content = readFileSync(join(REPO_ROOT, rel), "utf8");
    scanned++;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const next = lines[i + 1] ?? "";
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (lineIsExempt(line)) continue;
      for (const { key, re } of keyPatterns) {
        // The wrap case reads the NEXT line for two things: the per-line
        // exemptions (a `// canonical-casing-exempt` sits with the value, not
        // with the orphaned `key:`) and the `undefined` cleanup shape, which a
        // wrap spells `key:\n  undefined`.
        const isWrappedWrite =
          re.wrapped.test(line) &&
          next.trim() !== "" &&
          !/^\s*undefined\b/.test(next) &&
          !lineIsExempt(next);
        if (!re.same.test(line) && !isWrappedWrite) continue;
        const scope = excludedBy(rel, key);
        if (scope) {
          suppressed.add(`${scope.path}::${key}`);
          continue;
        }
        hits.push({ file: rel, line: i + 1, text: line.trim(), key });
      }
    }
  }
  return { hits, suppressed, scanned };
}

/**
 * Every exclusion must still be earning its place.
 *
 * The guard this replaces only asked whether a listed path still existed. That
 * left the more corrosive case open: a path that exists, whose camelCase use
 * was cleaned up years ago, still carrying an exclusion that now silently
 * covers whatever lands there next. Requiring each (path, key) pair to suppress
 * at least one real hit collapses both cases into one check — a deleted path
 * suppresses nothing, and so does a cleaned-up one.
 */
function deadExclusions(suppressed: Set<string>): string[] {
  const dead: string[] = [];
  for (const scope of EXCLUDED_SCOPES) {
    for (const key of scope.keys) {
      if (!suppressed.has(`${scope.path}::${key}`)) dead.push(`${scope.path}  [${key}]`);
    }
  }
  return dead;
}

function reportDeadExclusions(dead: string[]): void {
  console.error(
    `[lint-manifest-casing] FAIL — ${dead.length} EXCLUDED_SCOPES entr(y|ies) suppress nothing:\n` +
      dead.map((d) => `  - ${d}`).join("\n") +
      "\n\nEither the path moved, or the camelCase use it covered is gone. An exclusion that\n" +
      "matches nothing today will silently cover whatever appears at that path tomorrow —\n" +
      "delete the entry, or repoint it.\n",
  );
}

function reportHits(hits: Hit[]): void {
  console.error(
    `[lint-manifest-casing] FAIL — ${hits.length} suspect line(s) emit legacy camelCase manifest keys.\n`,
  );
  console.error(
    "AFPS requires canonical snake_case (display_name, schema_version, file_constraints, ui_hints,\n" +
      "property_order, max_size, icon_url, runtime_tools, …). If this hit is a legitimate read-fallback or\n" +
      "documented carve-out, prefix the line with `// canonical-casing-exempt` or `// back-compat`. If a\n" +
      "whole surface legitimately spells the name in camelCase (a DB column, a module descriptor, a view\n" +
      "model), add a key-scoped entry to EXCLUDED_SCOPES with the reason. If it's a writer context, switch\n" +
      "to the canonical snake_case key.\n",
  );
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.key}]  ${h.text}`);
  }
}

/**
 * Both failure classes are reported, then the process exits ONCE.
 *
 * The dead-exclusion check used to `process.exit(1)` from inside itself, before
 * a single hit had been printed. So the run that most needs the hit list — a
 * refactor that both cleaned up one camelCase surface and introduced a leak
 * somewhere else — showed only the stale entry, and the leak surfaced on the
 * NEXT run, after somebody had already edited this file. The two classes are
 * independent findings about the same scan; neither is a precondition for
 * printing the other.
 */
function main(): void {
  const { hits, suppressed, scanned } = scan();
  const dead = deadExclusions(suppressed);

  if (dead.length === 0 && hits.length === 0) {
    console.log(
      `[lint-manifest-casing] OK — no legacy camelCase manifest-key writer contexts found ` +
        `(${scanned} tracked source files scanned, ${EXCLUDED_SCOPES.length} documented exclusions).`,
    );
    process.exit(0);
  }

  if (dead.length > 0) reportDeadExclusions(dead);
  if (hits.length > 0) reportHits(hits);
  process.exit(1);
}

main();
