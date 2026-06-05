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

const POLICY = (process.env.MODULE_ISOLATION_POLICY ?? "fail") as "warn" | "fail" | "off";
const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");

/** Absolute module roots, keyed by module id. */
const MODULE_ROOTS: Record<string, string> = {};
for (const builtin of ["oidc", "webhooks", "core-providers"]) {
  MODULE_ROOTS[builtin] = resolve(ROOT, "apps/api/src/modules", builtin);
}
// Workspace npm modules (packages/module-*/src).
{
  const glob = new Glob("module-*/src");
  for await (const rel of glob.scan({ cwd: resolve(ROOT, "packages"), onlyFiles: false })) {
    const id = rel.split("/")[0].replace(/^module-/, "");
    MODULE_ROOTS[id] = resolve(ROOT, "packages", rel);
  }
}

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

const problems: string[] = [];
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
          problems.push(
            `${moduleId}/${rel} imports \`${spec}\` → reaches into module \`${owner}\`. ` +
              `Modules talk via the platform API/events, never a direct cross-module import.`,
          );
        }
        continue;
      }

      // Bare specifier naming another module's npm package.
      const pkgMatch = /^@appstrate\/module-([a-z0-9-]+)/.exec(spec);
      if (pkgMatch) {
        const owner = pkgMatch[1];
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

for (const p of problems) console.error(`❌ ${p}`);

if (problems.length === 0) {
  console.log(
    `✅ module isolation clean — ${filesScanned} files across ${Object.keys(MODULE_ROOTS).length} modules, no cross-module imports.`,
  );
}

if (problems.length > 0 && POLICY === "fail") process.exit(1);
