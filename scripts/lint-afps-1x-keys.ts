// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

/**
 * lint-afps-1x-keys — repo-level grep lint for AFPS-1.x camelCase manifest keys
 * leaking into writer contexts. Wave-3 long-term safeguard against C1-class
 * bugs (see /tmp/afps-audit/FINAL-REPORT.md): a writer accidentally emitting
 * `displayName: …` in newly-created manifest payloads.
 *
 * Strategy — narrow but precise: only flag camelCase manifest-key writes in
 * contexts that look like AFPS manifest construction. False positives are
 * filtered three ways:
 *
 *  1. **Path scope**: scan only known AFPS manifest writer/editor sources
 *     (crud, validation, dependencies, integration, mcp-server, zip,
 *     agent-editor, package-editor, runtime-pi sidecar boot). The full repo
 *     is full of legit non-AFPS uses (React component `displayName`, Better
 *     Auth `profiles.displayName` DB column, Hono `maxSize` body limit, etc.)
 *     so a blanket scan generates 200+ FPs.
 *
 *  2. **Writer-shape requirement**: the key must appear as `<key>:` (object
 *     literal property) or `<obj>.<key> =` (manifest assignment) where
 *     `<obj>` is one of `manifest`, `finalManifest`, `m`, `payload`, `patch`,
 *     `wrapper`, or `output`. This catches the exact C1 leak shape
 *     (`finalManifest.displayName = …`) without dragging in DB queries or
 *     React `Foo.displayName = "Foo"`.
 *
 *  3. **Per-line exemptions**: `// AFPS-1.x`, `// back-compat`, the M8
 *     cleanup pattern (`<key>: undefined` / `delete m.<key>`), and read
 *     fallback chains (`?? m.<key>`).
 *
 * Exits non-zero on any hit. Hook into `turbo check` via the `lint:afps-1x`
 * script in root package.json.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

// Narrow scope: only files known to construct AFPS manifests on disk. Files
// that produce non-AFPS payloads (profiles, model providers, Hono middleware,
// React UI) are intentionally excluded.
const SCAN_FILES = [
  "apps/api/src/services/package-items",
  "apps/api/src/services/inline-manifest-validation.ts",
  "apps/api/src/services/integration-spawn-resolver.ts",
  "apps/api/src/services/integration-scope-resolver.ts",
  "apps/api/src/services/integration-scope-validation.ts",
  "apps/api/src/services/integration-service.ts",
  "apps/api/src/services/integration-pins-service.ts",
  "apps/api/src/services/skill-zip.ts",
  "apps/api/src/services/package-versions.ts",
  "apps/api/src/services/integration-connection-resolver.ts",
  "apps/api/src/services/registry-run-resolver.ts",
  "apps/web/src/components/agent-editor",
  "apps/web/src/pages/package-editor.tsx",
  "packages/core/src/validation.ts",
  "packages/core/src/dependencies.ts",
  "packages/core/src/integration.ts",
  "packages/core/src/zip.ts",
  "packages/core/src/mcp-server.ts",
  "packages/core/src/mcp-server-bundle",
  "packages/core/src/sidecar-types.ts",
  "packages/connect/src/afps-delivery.ts",
  "packages/connect/src/connect",
  "runtime-pi/sidecar/integrations-boot.ts",
  "runtime-pi/sidecar/integration-spawn-resolver.ts",
];

const FILE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// Banned AFPS-1.x camelCase manifest keys (AFPS-spec audit final report).
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
];

// Path-substring exemptions: documented back-compat surfaces.
const EXEMPT_PATHS = ["packages/core/src/back-compat.ts"];

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
function lineIsExempt(line: string): boolean {
  if (/\/\/.*AFPS-1\.x/.test(line)) return true;
  if (/\/\/.*back-compat/i.test(line)) return true;
  // Explicit per-line opt-out tag for documented TS-internal carve-outs
  // (e.g. agent-editor `MetadataState`/`SchemaField` field names — these
  // are TS-internal state types per CASING_CONVENTIONS.md, not manifest
  // wire keys; they translate to canonical snake_case via
  // `metadataToManifestPatch` / `fieldsToSchema`).
  if (/\/\/.*afps-1x-lint-ok\b/i.test(line)) return true;
  // Read fallback: `?? <obj>.<bannedKey>` (and `?? (<obj>.<bannedKey> as ...)`)
  if (
    /\?\?\s*\(?[\w.[\]'"`]*\.(displayName|schemaVersion|fileConstraints|uiHints|propertyOrder|maxSize|iconUrl|providersConfiguration|runtimeTools)\b/.test(
      line,
    )
  ) {
    return true;
  }
  // M8 cleanup: `displayName: undefined` / `delete m.runtimeTools` — these are
  // documented writer-side legacy-sibling strips.
  if (
    /\b(displayName|runtimeTools|fileConstraints|uiHints|propertyOrder|iconUrl|providersConfiguration|maxSize|schemaVersion)\s*:\s*undefined\b/.test(
      line,
    )
  ) {
    return true;
  }
  if (
    /\bdelete\s+[\w[\]'"`.()]+\.(displayName|runtimeTools|fileConstraints|uiHints|propertyOrder|iconUrl|providersConfiguration|maxSize|schemaVersion)\b/.test(
      line,
    )
  ) {
    return true;
  }
  // Reading from manifest: `manifest.displayName` / `m.displayName` — read
  // contexts are tolerated. Writes use `: <value>` or `= <value>`.
  // The writer-shape regex below already filters this implicitly, but keep
  // an explicit guard for `as { displayName?: … }` type-narrowing reads.
  if (
    /\bas\s*\{[^}]*\b(displayName|runtimeTools|fileConstraints|uiHints|propertyOrder|iconUrl|providersConfiguration|maxSize|schemaVersion)\b/.test(
      line,
    )
  ) {
    return true;
  }
  return false;
}

function walk(target: string, acc: string[]): void {
  let st;
  try {
    st = statSync(target);
  } catch {
    return;
  }
  if (st.isFile()) {
    const ext = target.slice(target.lastIndexOf("."));
    if (FILE_EXTS.has(ext)) acc.push(target);
    return;
  }
  if (!st.isDirectory()) return;
  let entries;
  try {
    entries = readdirSync(target);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    walk(join(target, entry), acc);
  }
}

interface Hit {
  file: string;
  line: number;
  text: string;
  key: string;
}

// Writer-shape regex for a banned key. Matches either:
//   1. Object literal property:  `<key>: <something-not-undefined>`
//      (the M8 cleanup `<key>: undefined` is filtered by lineIsExempt above.)
//   2. Manifest field assignment: `<obj>.<key> = <value>` where <obj> is one
//      of manifest, finalManifest, m, payload, patch, wrapper, output, draft,
//      entry, manif, item.
function buildWriterShapeRegex(key: string): RegExp {
  // Object-literal: `<key>:` not preceded by an alphanumeric (so we don't
  // match `someOtherDisplayName:`).
  // Assignment: `<obj>.<key> =` (not ==, not =>).
  const objNames = "(manifest|finalManifest|m|payload|patch|wrapper|output|draft|entry|manif|item)";
  return new RegExp(
    `(?:(?:^|[^A-Za-z0-9_$])${key}\\s*:\\s*[^u\\s])|` + // `<key>: value` (excludes `undefined` cheaply via [^u])
      `(?:\\b${objNames}(?:\\.[A-Za-z0-9_$]+)*\\.${key}\\s*=(?!=|>))`,
  );
}

function scan(): Hit[] {
  const files: string[] = [];
  for (const target of SCAN_FILES) walk(join(REPO_ROOT, target), files);

  const hits: Hit[] = [];
  const keyPatterns = BANNED_KEYS.map((k) => ({ key: k, re: buildWriterShapeRegex(k) }));

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (EXEMPT_PATHS.some((p) => rel.includes(p))) continue;
    if (isTestFile(file)) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (lineIsExempt(line)) continue;
      for (const { key, re } of keyPatterns) {
        if (re.test(line)) {
          hits.push({ file: rel, line: i + 1, text: line.trim(), key });
        }
      }
    }
  }
  return hits;
}

function main(): void {
  const hits = scan();
  if (hits.length === 0) {
    console.log(
      "[lint-afps-1x-keys] OK — no AFPS-1.x camelCase manifest-key writer contexts found.",
    );
    process.exit(0);
  }
  console.error(
    `[lint-afps-1x-keys] FAIL — ${hits.length} suspect line(s) emit AFPS-1.x camelCase manifest keys.\n`,
  );
  console.error(
    "AFPS requires canonical snake_case (display_name, schema_version, file_constraints, ui_hints,\n" +
      "property_order, max_size, icon_url, runtime_tools, …). If this hit is a legitimate read-fallback or\n" +
      "documented back-compat, prefix the line with `// AFPS-1.x` or `// back-compat`. If it's a writer\n" +
      "context, switch to the canonical snake_case key.\n",
  );
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.key}]  ${h.text}`);
  }
  process.exit(1);
}

main();
