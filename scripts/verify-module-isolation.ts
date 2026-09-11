// SPDX-License-Identifier: Apache-2.0

/**
 * Architecture test — module boundary isolation.
 *
 * SOTA modular-monolith rule (Jovanović, Ozkaya): a module accesses only its
 * own tables; it never reaches into another **module's** internals. Cross-module
 * data sharing goes through the platform API / events, never a direct import or
 * a cross-module SQL join. Core (`@appstrate/db`, `@appstrate/core`, platform
 * services injected at init) is a legitimate backward dependency — modules
 * reference core entities; that is the FK-backward-ref pattern, not a violation.
 *
 * What this enforces, in three directions:
 *   module → module. A module MUST NOT import another module's source tree —
 *   importing its `schema.ts` is how a cross-module SQL join sneaks in.
 *   core → module. No platform file may statically import a module, by bare
 *   specifier or by a relative path landing in a module root: modules are opt-in
 *   through `MODULES`, and a static import makes one mandatory and drags a
 *   differently-licensed tree into the Apache-2.0 one. The loader's computed
 *   `import(specifier)` is invisible to a specifier scan; a literal one is not.
 *   Apache-2.0 → commercial. NOTHING outside `packages/module-ee/` may statically
 *   import it — see `reviewCommercialDependencies`.
 * `apps/web` is out of scope of the core→module rule (the SPA imports a module's
 * UI on purpose). Test files are exempt module→module, and the platform→module
 * scan reads only `src` trees plus `scripts/` (including its tests). Neither
 * narrowing applies to the third direction, which reads EVERY tracked source
 * file in the repository: that is what closes the blind spot where a static
 * commercial import from `apps/api/test/**` or from `apps/web/**` passed every
 * gate.
 *
 * Override via env: `MODULE_ISOLATION_POLICY=warn|fail|off`.
 */

import { Glob } from "bun";
import { resolve, dirname, relative, sep, join } from "node:path";
import { readGatePolicy } from "./lib/policy-env.ts";
import { SOURCE_GLOBS, trackedFiles } from "./lib/tracked-files.ts";
import { REGEX_PRECEDERS, scanQuoted } from "./lib/ts-lexer.ts";

// Under CI the override is ignored, so a green pipeline can never be bought
// with `MODULE_ISOLATION_POLICY=off` — same pin `verify-module-contract.ts`
// carries for the same reason. `readGatePolicy` also REJECTS a value that is
// neither `warn`, `fail` nor `off`; the cast this replaces accepted anything
// and every non-`fail` value silently downgraded the exit below to 0 while the
// `❌` lines still printed.
const POLICY = readGatePolicy("MODULE_ISOLATION_POLICY");
const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");

/**
 * Cross-module imports that exist today and are accepted for now, each with the
 * reason and the exit. An entry is `<importing module>/<path>` → `<owning
 * module>`, narrowed to ONE import specifier by `spec`.
 *
 * `spec` is not decoration. Without it an acceptance keyed only on file and
 * owner grants that file blanket permission to import ANYTHING from that
 * module: the three entries this list used to hold each named a specific symbol
 * in their prose while matching every future import beside it. An acceptance
 * that widens itself as the code grows is the blind spot this gate exists to
 * close, one level down.
 *
 * Checked in BOTH directions by `reviewCrossModuleImports` below: an entry that
 * no longer matches a real import fails the gate, so this cannot quietly become
 * a list of things that were fixed years ago. The list is currently EMPTY — the
 * three `oidc → mcp` imports it carried are gone, the audience allowlist having
 * moved to `apps/api/src/lib/audiences.ts` where two built-ins can share it
 * without either reaching into the other.
 */
export interface AcceptedCrossModuleImport {
  from: string;
  to: string;
  spec: string;
  reason: string;
}

const ACCEPTED_CROSS_MODULE_IMPORTS: AcceptedCrossModuleImport[] = [];

/**
 * Absolute module roots, keyed by module id.
 *
 * Built-ins are DISCOVERED, not listed. A hardcoded list here read
 * `["oidc", "webhooks", "core-providers"]` while the directory held five: with
 * `mcp` and `firecracker` absent, `ownerOf()` returned null for anything under
 * them and the violation check — gated on a truthy owner — could not report an
 * import INTO either one. Three real `oidc → mcp` imports passed while the
 * script printed "module isolation clean". The discovery form below is the one
 * `knip.config.ts` and `scripts/lib/module-openapi.ts` already use.
 */
const MODULE_ROOTS: Record<string, string> = {};

/** Which module root (if any) an absolute path belongs to. */
function ownerOf(absPath: string): string | null {
  for (const [id, root] of Object.entries(MODULE_ROOTS)) {
    const rel = relative(root, absPath);
    if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) return id;
  }
  return null;
}

// Three forms, the third because a side-effect `import "x"` is how a static
// module import would be written. The `import()` branch takes a backtick but
// rejects `${`: a literal `import(`@appstrate/module-x`)` is caught, the
// loader's computed specifier stays invisible.
const IMPORT_RE =
  /\b(?:import|export)\b[^"']*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*[`"']([^`"'$]+)[`"']|\bimport\s+["']([^"']+)["']/g;

/**
 * Blank the comments out: a commented-out import is not one. Strings are walked
 * over so a `//` inside a specifier opens no comment, and so are regex literals
 * — an unclosed `["']` would swallow the code behind it.
 */
function stripComments(source: string): string {
  let out = "";
  let prev = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const opensRegex = ch === "/" && (prev === "" || REGEX_PRECEDERS.has(prev));
    if (ch === '"' || ch === "'" || ch === "`" || opensRegex) {
      const close = opensRegex ? "/" : ch;
      const end = scanQuoted(source, i, close);
      // The literal is copied through — the specifier of a real import IS a
      // literal — but its INTERIOR quotes are blanked, because a quote inside
      // one cannot open the specifier of an import: the whole literal is one
      // token. Without this, a source that merely QUOTES an import statement
      // (`'import "@appstrate/module-ee";'`, which is how this gate's own test
      // feeds it synthetic input) matches as if it performed one. A real
      // specifier never contains a quote, so this only ever removes matches.
      // An unterminated literal (EOF, or a regex closed by a newline) is copied
      // verbatim: there is no interior to blank without eating a real character.
      const raw = source.slice(i, end);
      out +=
        raw.length >= 2 && raw.endsWith(close)
          ? raw[0]! + raw.slice(1, -1).replace(/["'`]/g, "�") + close
          : raw;
      i = end;
      prev = close;
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return out;
}

/** One relative import that crossed a module boundary, as the scan saw it. */
export interface CrossModuleImport {
  /** `<importing module>/<path relative to that module's root>`. */
  from: string;
  /** Module id the import lands in. */
  to: string;
  /** The import specifier, verbatim. */
  spec: string;
}

/**
 * Decide, for one scan's worth of cross-module imports, which are violations
 * and which acceptances have gone stale. Pure: the scan feeds it real imports,
 * `test/unit/module-isolation-acceptances.test.ts` feeds it synthetic ones.
 *
 * An acceptance is matched by IDENTITY, not by a string key. The two directions
 * used to build their own key and disagreed: the matcher wrote
 * `from→to→spec` while the staleness pass read `from→to`, so the first entry
 * anyone added to `ACCEPTED_CROSS_MODULE_IMPORTS` would have been matched by a
 * real import AND reported as "no such import exists any more" in the same run
 * — the gate failing with the exact opposite of the truth. Both blocks landed
 * in one commit and the list has been empty since, so nothing ever exercised
 * them. Holding the entry object itself removes the key, and with it the only
 * way the two passes can drift apart again.
 */
export function reviewCrossModuleImports(
  imports: readonly CrossModuleImport[],
  accepted: readonly AcceptedCrossModuleImport[],
): string[] {
  const problems: string[] = [];
  const matched = new Set<AcceptedCrossModuleImport>();

  for (const imp of imports) {
    const entry = accepted.find(
      (e) => e.from === imp.from && e.to === imp.to && e.spec === imp.spec,
    );
    if (entry) {
      matched.add(entry);
      continue;
    }
    problems.push(
      `${imp.from} imports \`${imp.spec}\` → reaches into module \`${imp.to}\`. ` +
        `Modules talk via the platform API/events, never a direct cross-module import.`,
    );
  }

  // Stale acceptance = an entry describing an import that no longer exists. It
  // is a failure, not a nit: an allowlist only checked in the "is it still
  // allowed" direction silently becomes a record of things fixed long ago,
  // which is how the endpoint allowlists in verify-openapi.ts accumulated dead
  // entries.
  for (const entry of accepted) {
    if (matched.has(entry)) continue;
    problems.push(
      `ACCEPTED_CROSS_MODULE_IMPORTS lists \`${entry.from}\` → \`${entry.to}\` ` +
        `(\`${entry.spec}\`), but no such import exists any more. Delete the entry.`,
    );
  }

  return problems;
}

/** One import statement found in platform (non-module) source. */
export interface PlatformImport {
  file: string;
  spec: string;
  /** Repo-relative path the specifier resolves to — relative imports only. */
  resolved?: string;
}

/** Repo-relative prefixes a resolved relative import lands on inside a module. */
const MODULE_PATH_PREFIXES = ["packages/module-", "apps/api/src/modules/"];

/**
 * Decide which platform imports reach into a module. Pure — the tests feed it
 * synthetic ones. No acceptance list: an empty allowlist is a door left open.
 */
export function reviewPlatformModuleImports(imports: readonly PlatformImport[]): string[] {
  const problems: string[] = [];
  for (const imp of imports) {
    const bare = /^@appstrate\/module-[a-z0-9-]+/.exec(imp.spec);
    const resolved = imp.resolved;
    const reaches =
      bare !== null ||
      (resolved !== undefined && MODULE_PATH_PREFIXES.some((p) => resolved.startsWith(p)));
    if (!reaches) continue;
    problems.push(
      `${imp.file} imports \`${imp.spec}\` → reaches into a module. Modules are opt-in at ` +
        `runtime through MODULES; the platform loads them with a computed \`import(specifier)\`, ` +
        `never a static one.`,
    );
  }
  return problems;
}

/**
 * The commercial tree — the repository's ONE non-Apache-2.0 directory, the same
 * prefix `verify-license-boundary.ts` checks headers against.
 */
const COMMERCIAL_MODULE_PREFIX = "packages/module-ee/";
const COMMERCIAL_MODULE_SPEC = "@appstrate/module-ee";

/**
 * Decide which files take a STATIC dependency on the commercial tree. Pure — the
 * scan feeds it every tracked source file outside `packages/module-ee/`, the
 * tests feed it synthetic ones.
 *
 * A direction of its own rather than a wider `platformRoots` list: the core→module rule is
 * narrowed for legitimate cases (`apps/web` imports module UI, tests drive modules), and the
 * licence rule has none — so it reads every tracked source file with no exemption list to keep
 * current.
 *
 * The module's own files are excluded by the caller, not here: reaching into
 * itself is not a cross-licence import.
 */
export function reviewCommercialDependencies(imports: readonly PlatformImport[]): string[] {
  const problems: string[] = [];
  for (const imp of imports) {
    const reaches =
      imp.spec === COMMERCIAL_MODULE_SPEC ||
      imp.spec.startsWith(`${COMMERCIAL_MODULE_SPEC}/`) ||
      imp.resolved?.startsWith(COMMERCIAL_MODULE_PREFIX) === true;
    if (!reaches) continue;
    problems.push(
      `${imp.file} imports \`${imp.spec}\` → reaches into \`${COMMERCIAL_MODULE_PREFIX}\`, the one ` +
        `source-available tree in this repository. No Apache-2.0 file may depend on it statically: ` +
        `the module is opt-in through MODULES and removable from a redistribution, so this import ` +
        `is both a licence leak and a build that dies with the directory.`,
    );
  }
  return problems;
}

/** Is `rel` (relative to a scan root) source this gate reads? Exported so a test pins it. */
export function isScannedSource(rel: string, includeTests: boolean): boolean {
  if (rel.includes("node_modules/")) return false;
  if (includeTests) return true;
  return !(rel.includes("/test/") || rel.startsWith("test/") || /\.test\.tsx?$/.test(rel));
}

/** Every source file under `root` — one definition of "source", not two. */
async function sourceFilesUnder(root: string, includeTests = false): Promise<string[]> {
  const files: string[] = [];
  const glob = new Glob("**/*.{ts,tsx}");
  for await (const rel of glob.scan({ cwd: root })) {
    if (isScannedSource(rel, includeTests)) files.push(rel);
  }
  return files;
}

/** Every import specifier in `source`, comments excluded, in order. */
export function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const m of stripComments(source).matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

// Guarded so tests can import the pure review logic above without running the
// scan — which walks the repo and would exit(1) on a real violation.
if (import.meta.main) {
  {
    const builtinsDir = resolve(ROOT, "apps/api/src/modules");
    const glob = new Glob("*/index.ts");
    for await (const rel of glob.scan({ cwd: builtinsDir })) {
      const id = rel.split("/")[0]!;
      MODULE_ROOTS[id] = resolve(builtinsDir, id);
    }
    if (Object.keys(MODULE_ROOTS).length === 0) {
      console.error(
        `❌ no built-in modules discovered under ${builtinsDir} — the scan would be vacuous.`,
      );
      process.exit(1);
    }
  }
  // Workspace npm modules — root is the PACKAGE dir, since module code lives outside `src/` too.
  {
    const glob = new Glob("module-*/package.json");
    for await (const rel of glob.scan({ cwd: resolve(ROOT, "packages") })) {
      if (rel.includes("node_modules/")) continue;
      const dir = rel.slice(0, rel.indexOf("/"));
      const id = dir.replace(/^module-/, "");
      // Refuse a collision rather than overwrite. This loop runs SECOND and wrote
      // into the same map as the built-in discovery above, so extracting a
      // built-in to `packages/module-<same-id>` would silently drop the built-in's
      // root from the scan — `ownerOf()` returns null for it and every import into
      // it becomes invisible. That is precisely the blind spot the hardcoded
      // inventory used to have, reproduced without even the module count dropping.
      if (MODULE_ROOTS[id]) {
        console.error(
          `❌ module id \`${id}\` is claimed twice: ${MODULE_ROOTS[id]} and ` +
            `${resolve(ROOT, "packages", dir)}. One would shadow the other and ` +
            `un-scan it in silence — rename one.`,
        );
        process.exit(1);
      }
      MODULE_ROOTS[id] = resolve(ROOT, "packages", dir);
    }
  }

  const problems: string[] = [];
  const crossModuleImports: CrossModuleImport[] = [];
  const scannedFiles: string[] = [];
  const verbose = process.argv.includes("--verbose");
  let filesScanned = 0;

  for (const [moduleId, root] of Object.entries(MODULE_ROOTS)) {
    for (const rel of await sourceFilesUnder(root)) {
      const filePath = resolve(root, rel);
      const source = await Bun.file(filePath).text();
      filesScanned++;
      scannedFiles.push(relative(ROOT, filePath).split(sep).join("/"));

      for (const spec of importSpecifiers(source)) {
        // Relative import → resolve and check the owning module.
        if (spec.startsWith(".")) {
          const target = resolve(dirname(filePath), spec);
          const owner = ownerOf(target);
          if (owner && owner !== moduleId) {
            crossModuleImports.push({ from: `${moduleId}/${rel}`, to: owner, spec });
          }
          continue;
        }

        // Bare specifier naming another module's npm package. No acceptance
        // path: a package dependency is declared in a manifest, so there is
        // never an "it already exists, grandfather it" case to narrow.
        const pkgMatch = /^@appstrate\/module-([a-z0-9-]+)/.exec(spec);
        if (pkgMatch) {
          const owner = pkgMatch[1]!;
          if (MODULE_ROOTS[owner] && owner !== moduleId) {
            problems.push(
              `${moduleId}/${rel} imports \`${spec}\` (module \`${owner}\`'s package). ` +
                `Cross-module dependency forbidden — go through the platform contract.`,
            );
          }
        }
      }
    }
  }

  problems.push(...reviewCrossModuleImports(crossModuleImports, ACCEPTED_CROSS_MODULE_IMPORTS));

  // ─── core → module ──────────────────────────────────────────────────
  // Every non-module tree the platform ships or builds itself with (`apps/web`
  // absent on purpose — see the header). Built-ins live UNDER `apps/api/src`, so
  // a file that is a module's own is skipped: reaching into itself is not a
  // platform import. `scripts/` stays in scope: `scripts/lib/module-openapi.ts`
  // loads modules by a computed `import(entry)`, the form this gate deliberately
  // cannot see, and nothing there names a module in a literal specifier.
  // `scripts/test/**` is platform code; the other roots' tests drive a module on purpose.
  const platformRoots: { dir: string; includeTests: boolean }[] = [
    { dir: resolve(ROOT, "apps/api/src"), includeTests: false },
    { dir: resolve(ROOT, "apps/cli/src"), includeTests: false },
    { dir: resolve(ROOT, "runtime-pi"), includeTests: false },
    { dir: resolve(ROOT, "scripts"), includeTests: true },
    { dir: resolve(ROOT, "e2e"), includeTests: false },
  ];
  {
    const glob = new Glob("*/src");
    for await (const rel of glob.scan({ cwd: resolve(ROOT, "packages"), onlyFiles: false })) {
      if (rel.startsWith("module-")) continue;
      platformRoots.push({ dir: resolve(ROOT, "packages", rel), includeTests: false });
    }
  }

  const platformImports: PlatformImport[] = [];
  let platformFilesScanned = 0;
  for (const { dir: root, includeTests } of platformRoots) {
    for (const rel of await sourceFilesUnder(root, includeTests)) {
      const filePath = resolve(root, rel);
      if (ownerOf(filePath)) continue;
      const source = await Bun.file(filePath).text();
      platformFilesScanned++;
      const file = relative(ROOT, filePath).split(sep).join("/");
      scannedFiles.push(file);
      for (const spec of importSpecifiers(source)) {
        const resolved = spec.startsWith(".")
          ? relative(ROOT, resolve(dirname(filePath), spec))
              .split(sep)
              .join("/")
          : undefined;
        platformImports.push({ file, spec, resolved });
      }
    }
  }
  problems.push(...reviewPlatformModuleImports(platformImports));

  // ─── Apache-2.0 → commercial ────────────────────────────────────────
  // Every tracked source file, the commercial tree excepted. Population from the git INDEX, so a
  // new directory is covered the day its first file is committed. A file the platform→module pass
  // above already read can report twice: both lines are true and both are fatal.
  const commercialImports: PlatformImport[] = [];
  const licensedFiles = trackedFiles(SOURCE_GLOBS, "source file", "skip").filter(
    (file) => !file.startsWith(COMMERCIAL_MODULE_PREFIX),
  );
  // Bounded batches: one `await` per file is I/O-bound enough to blow this gate's own test
  // timeout, and one `Promise.all` over everything would blow `ulimit -n`.
  const BATCH = 512;
  for (let i = 0; i < licensedFiles.length; i += BATCH) {
    const batch = licensedFiles.slice(i, i + BATCH);
    const sources = await Promise.all(batch.map((f) => Bun.file(join(ROOT, f)).text()));
    batch.forEach((file, n) => {
      scannedFiles.push(file);
      for (const spec of importSpecifiers(sources[n]!)) {
        const resolved = spec.startsWith(".")
          ? relative(ROOT, resolve(dirname(join(ROOT, file)), spec))
              .split(sep)
              .join("/")
          : undefined;
        commercialImports.push({ file, spec, resolved });
      }
    });
  }
  problems.push(...reviewCommercialDependencies(commercialImports));

  // Deduplicated: the commercial pass re-reads files the platform pass already
  // listed, and a `--verbose` roster that names one file twice reads as a bug.
  if (verbose)
    for (const file of [...new Set(scannedFiles)].sort()) console.log(`   scanned: ${file}`);

  for (const p of problems) console.error(`❌ ${p}`);

  if (problems.length === 0) {
    const accepted = ACCEPTED_CROSS_MODULE_IMPORTS.length;
    console.log(
      `✅ module isolation clean — ${filesScanned} files across ${Object.keys(MODULE_ROOTS).length} modules, ` +
        `${platformFilesScanned} platform files with no static module import, ` +
        `${licensedFiles.length} tracked files with no static import of ${COMMERCIAL_MODULE_PREFIX}` +
        `${accepted > 0 ? `, ${accepted} accepted cross-module import(s)` : ", no cross-module imports"}.`,
    );
    for (const e of ACCEPTED_CROSS_MODULE_IMPORTS) {
      console.log(`   accepted: ${e.from} → ${e.to} — ${e.reason}`);
    }
  }

  if (problems.length > 0 && POLICY === "fail") process.exit(1);
}
