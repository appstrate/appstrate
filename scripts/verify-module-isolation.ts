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
 * What this enforces, concretely:
 *   A module under `apps/api/src/modules/<m>` (or `packages/module-<m>/src`)
 *   MUST NOT import from another module's source tree. Importing another
 *   module's `schema.ts` is exactly how a cross-module SQL join would sneak in,
 *   so banning cross-module imports kills the join at the source.
 *
 * Scope: in-repo modules only. cloud lives in a separate repo and enforces its
 * own equivalent (its `usage-recorder.ts` cross-join into core `llm_usage` is
 * the known violation tracked by the data-isolation plan — fixed there, not here).
 *
 * Override via env: `MODULE_ISOLATION_POLICY=warn|fail|off`.
 */

import { Glob } from "bun";
import { resolve, dirname, relative, sep } from "node:path";

// Under CI the override is ignored, so a green pipeline can never be bought
// with `MODULE_ISOLATION_POLICY=off` — same pin `verify-module-contract.ts`
// carries for the same reason.
const POLICY = process.env.CI
  ? "fail"
  : ((process.env.MODULE_ISOLATION_POLICY ?? "fail") as "warn" | "fail" | "off");
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

const IMPORT_RE =
  /\b(?:import|export)\b[^"']*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g;

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
  // Workspace npm modules (packages/module-*/src).
  {
    const glob = new Glob("module-*/src");
    for await (const rel of glob.scan({ cwd: resolve(ROOT, "packages"), onlyFiles: false })) {
      const id = rel.split("/")[0]!.replace(/^module-/, "");
      // Refuse a collision rather than overwrite. This loop runs SECOND and wrote
      // into the same map as the built-in discovery above, so extracting a
      // built-in to `packages/module-<same-id>` would silently drop the built-in's
      // root from the scan — `ownerOf()` returns null for it and every import into
      // it becomes invisible. That is precisely the blind spot the hardcoded
      // inventory used to have, reproduced without even the module count dropping.
      if (MODULE_ROOTS[id]) {
        console.error(
          `❌ module id \`${id}\` is claimed twice: ${MODULE_ROOTS[id]} and ` +
            `${resolve(ROOT, "packages", rel)}. One would shadow the other and ` +
            `un-scan it in silence — rename one.`,
        );
        process.exit(1);
      }
      MODULE_ROOTS[id] = resolve(ROOT, "packages", rel);
    }
  }

  const problems: string[] = [];
  const crossModuleImports: CrossModuleImport[] = [];
  let filesScanned = 0;

  for (const [moduleId, root] of Object.entries(MODULE_ROOTS)) {
    const glob = new Glob("**/*.ts");
    for await (const rel of glob.scan({ cwd: root })) {
      if (rel.includes("/test/") || rel.startsWith("test/") || rel.endsWith(".test.ts")) continue;
      const filePath = resolve(root, rel);
      const source = await Bun.file(filePath).text();
      filesScanned++;

      for (const m of source.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2];
        if (!spec) continue;

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

  for (const p of problems) console.error(`❌ ${p}`);

  if (problems.length === 0) {
    const accepted = ACCEPTED_CROSS_MODULE_IMPORTS.length;
    console.log(
      `✅ module isolation clean — ${filesScanned} files across ${Object.keys(MODULE_ROOTS).length} modules` +
        `${accepted > 0 ? `, ${accepted} accepted cross-module import(s)` : ", no cross-module imports"}.`,
    );
    for (const e of ACCEPTED_CROSS_MODULE_IMPORTS) {
      console.log(`   accepted: ${e.from} → ${e.to} — ${e.reason}`);
    }
  }

  if (problems.length > 0 && POLICY === "fail") process.exit(1);
}
