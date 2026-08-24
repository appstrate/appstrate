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
 * module>`.
 *
 * Checked in BOTH directions: an entry that no longer matches a real import
 * fails the gate, so this cannot quietly become a list of things that were
 * fixed years ago.
 */
const ACCEPTED_CROSS_MODULE_IMPORTS: { from: string; to: string; reason: string }[] = [
  {
    from: "oidc/auth/strategy.ts",
    to: "mcp",
    reason:
      "`extractOrgIdFromAudiences` — audience parsing is platform vocabulary that " +
      "landed in the mcp module. Move it to core; tracked, not fixed here.",
  },
  {
    from: "oidc/auth/plugins.ts",
    to: "mcp",
    reason: "`mcpValidAudiences` / `initMcpValidAudiences` — same move as above.",
  },
  {
    from: "oidc/services/enduser-token.ts",
    to: "mcp",
    reason: "`getEndUserVerifyAudiences` — same move as above.",
  },
];

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
const matchedAcceptances = new Set<string>();
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
          const accepted = ACCEPTED_CROSS_MODULE_IMPORTS.find(
            (e) => e.from === `${moduleId}/${rel}` && e.to === owner,
          );
          if (accepted) {
            matchedAcceptances.add(`${accepted.from}→${accepted.to}`);
          } else {
            problems.push(
              `${moduleId}/${rel} imports \`${spec}\` → reaches into module \`${owner}\`. ` +
                `Modules talk via the platform API/events, never a direct cross-module import.`,
            );
          }
        }
        continue;
      }

      // Bare specifier naming another module's npm package.
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

// Stale acceptance = an entry describing an import that no longer exists. It is
// a failure, not a nit: an allowlist only checked in the "is it still allowed"
// direction silently becomes a record of things fixed long ago, which is how
// the endpoint allowlists in verify-openapi.ts accumulated dead entries.
for (const entry of ACCEPTED_CROSS_MODULE_IMPORTS) {
  if (!matchedAcceptances.has(`${entry.from}→${entry.to}`)) {
    problems.push(
      `ACCEPTED_CROSS_MODULE_IMPORTS lists \`${entry.from}\` → \`${entry.to}\`, but no such ` +
        `import exists any more. Delete the entry.`,
    );
  }
}

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
