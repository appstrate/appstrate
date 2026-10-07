#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Consumer-resolution gate for our SOURCE-ONLY npm packages.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@appstrate/core` and `@appstrate/afps-shared` publish `src/**` as `.ts` and map
 * every `exports` subpath at a `.ts` file. There is no build step and no `.d.ts`
 * barrier, so the CONSUMER's `tsc` compiles our source. Anything our source imports
 * — including type-only packages like `@types/semver` / `@types/json-schema` — must
 * therefore resolve in the CONSUMER's install, i.e. be declared in our
 * `dependencies` (not `devDependencies`).
 *
 * Typechecking inside this monorepo cannot catch a violation: the ROOT
 * `package.json` devDependencies hoist those type packages into the shared
 * `node_modules`, so `tsc --noEmit` in `packages/core` is green while
 * `npm install @appstrate/core` in a clean project explodes with TS2307 / TS7016.
 * That is exactly how the missing `@types/json-schema` / `@types/semver`
 * declarations shipped.
 *
 * WHAT IT DOES
 * ------------
 *   1. `npm pack` the target package (the real publish artifact — `files` and all).
 *   2. Create a throwaway project in the OS temp dir, OUTSIDE the monorepo, so no
 *      workspace hoisting can leak in.
 *   3. `npm install` (npm, never bun — bun would resolve workspace links) the
 *      tarball plus what a consumer legitimately brings: `typescript`,
 *      `@types/bun` (we declare `engines.bun`, so a Bun toolchain is the baseline),
 *      and EVERY declared peerDependency, optional ones included — the probe
 *      imports every subpath, and the S3/Hono subpaths are unusable without them.
 *   4. Generate a probe importing EVERY subpath from the package's `exports` map,
 *      read at runtime so the list cannot rot when a new export is added.
 *   5. `tsc --noEmit` under `strict` against the probe.
 *
 * COST: it hits the public npm registry, so it is not free and not offline —
 * measured at ~5 s for core and ~2 s for afps-shared with a COLD npm cache. In CI
 * the surrounding checkout + toolchain setup dominates. A registry outage fails
 * this gate; that is the price of testing the artifact rather than the workspace.
 *
 * THE DEPENDENCY CONTRACT THIS ENCODES (decisions, not accidents)
 * --------------------------------------------------------------
 *   `dependencies`      Everything our source imports unconditionally, INCLUDING
 *                       `@types/*` packages for untyped runtime deps. A
 *                       source-shipping package needs its type packages at
 *                       consumer install time, so `devDependencies` is wrong for
 *                       them: it is what made this gate necessary.
 *   `peerDependencies`  Libraries the consumer supplies. `typescript` is required
 *                       (there is no `.d.ts` to fall back on). `@aws-sdk/client-s3`,
 *                       `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner` and
 *                       `hono` are OPTIONAL peers, and it is EXPECTED and correct
 *                       that `@appstrate/core/storage-s3` (AWS SDK) or
 *                       `@appstrate/core/module` / `/telemetry` (Hono) fail to
 *                       typecheck without them — those subpaths are drivers for
 *                       exactly those libraries, and the rest of core stays usable
 *                       without pulling ~20 MB of AWS SDK. The probe therefore
 *                       installs every declared peer, optional ones included,
 *                       because it imports every subpath.
 *   Ambient types       `@types/bun`. `engines.bun` already declares a Bun runtime,
 *                       core calls `Bun.*` (storage-fs, mcp-server-bundle) and
 *                       imports `node:*`. We deliberately do NOT add `@types/bun`
 *                       to `dependencies`: a hoisted global-types package silently
 *                       injects globals into the consumer's whole program. Every
 *                       legitimate consumer already has it.
 *
 * WORKSPACE DEPENDENCIES NOT ON NPM YET
 * -------------------------------------
 * By default every dependency comes from the registry, so a consumer whose range
 * names a leaf version npm does not have (`@appstrate/core` → `@appstrate/afps-shared`)
 * fails. That is the release-order guarantee, and the publish workflows rely on it.
 *
 * `--pack-unpublished-workspace-deps` (PR and `main` CI only) relaxes exactly one
 * case: a `dependencies` entry naming a workspace package whose range floor IS that
 * workspace's version, and that version is not on npm. That leaf is installed from
 * an `npm pack` of the workspace instead, and the log says so. It lets the PR that
 * bumps a leaf and its consumer's floor together go green; the leaf is tagged after
 * merge, and the consumer's publish still refuses it until it is on npm.
 *
 * USAGE
 *   bun scripts/verify-package-resolves.ts packages/core
 *   bun scripts/verify-package-resolves.ts packages/core --pack-unpublished-workspace-deps
 *   bun scripts/verify-package-resolves.ts packages/afps-shared --keep
 *
 * `--keep` leaves the probe project on disk for manual poking.
 */

import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { overrideFloor as rangeFloor } from "./verify-overrides.ts";

const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    keep: { type: "boolean", default: false },
    "pack-unpublished-workspace-deps": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const packageDirArg = positionals[0];
if (!packageDirArg) {
  console.error(
    "Usage: bun scripts/verify-package-resolves.ts <packageDir> [--pack-unpublished-workspace-deps] [--keep]",
  );
  console.error("  e.g. bun scripts/verify-package-resolves.ts packages/core");
  process.exit(2);
}
const packageDir = resolve(ROOT, packageDirArg);

interface PackageJson {
  name: string;
  version: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifestPath = join(packageDir, "package.json");
if (!(await Bun.file(manifestPath).exists())) {
  console.error(`❌ no package.json at ${manifestPath}`);
  process.exit(2);
}
const pkg = (await Bun.file(manifestPath).json()) as PackageJson;

/**
 * Subpaths from the `exports` map, read at runtime. Sugar (`exports: "./x.ts"`)
 * and the root `.` entry both collapse to the bare package name.
 */
function subpathsOf(p: PackageJson): string[] {
  const exp = p.exports;
  if (!exp || typeof exp !== "object") return [p.name];
  const keys = Object.keys(exp).filter((k) => k.startsWith("."));
  if (keys.length === 0) return [p.name];
  return keys
    .filter((k) => !k.includes("*")) // wildcard subpaths have no single importable id
    .map((k) => (k === "." ? p.name : `${p.name}/${k.slice(2)}`))
    .sort();
}

const subpaths = subpathsOf(pkg);
if (subpaths.length === 0) {
  console.error(`❌ ${pkg.name} declares no importable subpath in its exports map`);
  process.exit(2);
}

/** Every workspace package of the root `workspaces` globs, by name. */
async function workspacePackages(): Promise<Map<string, { dir: string; version: string }>> {
  const root = (await Bun.file(join(ROOT, "package.json")).json()) as { workspaces?: string[] };
  const byName = new Map<string, { dir: string; version: string }>();
  for (const pattern of root.workspaces ?? []) {
    for (const path of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: ROOT })) {
      const ws = (await Bun.file(join(ROOT, path)).json()) as PackageJson;
      byName.set(ws.name, { dir: dirname(join(ROOT, path)), version: ws.version });
    }
  }
  return byName;
}

/** Whether `name@version` is on the npm registry; anything but 200/404 is an error. */
async function isOnNpm(name: string, version: string): Promise<boolean> {
  const res = await fetch(`https://registry.npmjs.org/${name}/${version}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`npm registry answered ${res.status} for ${name}@${version}`);
}

function run(
  cmd: string[],
  cwd: string,
): { ok: boolean; code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: proc.exitCode === 0,
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function fail(headline: string, detail: string, probeDir: string): never {
  console.error("");
  console.error(`❌ ${headline}`);
  console.error("");
  console.error(detail.trimEnd());
  console.error("");
  console.error("─".repeat(72));
  console.error(
    `A consumer running \`npm install ${pkg.name}\` would hit this. ${pkg.name} ships\n` +
      `source \`.ts\` (no build, no .d.ts), so the consumer's tsc compiles our files and\n` +
      `every import we make must resolve in THEIR install.\n` +
      `\n` +
      `Fix, in order of likelihood:\n` +
      `  • "Could not find a declaration file for module 'x'" (TS7016)\n` +
      `      → add the matching \`@types/x\` to ${packageDirArg}/package.json "dependencies"\n` +
      `        (NOT devDependencies — a source-shipping package needs it at consumer\n` +
      `        install time), pinned consistently with the root package.json.\n` +
      `  • "Cannot find module 'x'" (TS2307)\n` +
      `      → the import is undeclared: add \`x\` to "dependencies", or declare it as a\n` +
      `        peerDependency if the consumer is meant to supply it.\n` +
      `  • "Cannot find module '@scope/pkg/sub'" for one of OUR packages\n` +
      `      → that version is not on npm yet. Publish the leaf first\n` +
      `        (@appstrate/afps-shared → @appstrate/core → consumers).\n` +
      `  • A file listed in "exports" is missing from the tarball\n` +
      `      → widen the "files" array.\n` +
      `\n` +
      `Reproduce locally:  bun ${["scripts/verify-package-resolves.ts", packageDirArg, "--keep"].join(" ")}\n` +
      `Probe project:      ${probeDir}`,
  );
  process.exit(1);
}

const probeDir = await mkdtemp(join(tmpdir(), "appstrate-pkg-probe-"));
let keepDir = values.keep;

try {
  console.log(`▸ package   ${pkg.name}@${pkg.version}  (${packageDirArg})`);
  console.log(`▸ subpaths  ${subpaths.length} from the exports map`);
  console.log(`▸ probe     ${probeDir}`);

  // 1. Pack the real publish artifact.
  console.log("▸ npm pack …");
  const packed = run(
    ["npm", "pack", "--ignore-scripts", "--silent", "--pack-destination", probeDir],
    packageDir,
  );
  if (!packed.ok) {
    fail("npm pack failed", packed.stderr || packed.stdout, probeDir);
  }
  const tarball = (await readdir(probeDir)).find((f) => f.endsWith(".tgz"));
  if (!tarball) {
    fail("npm pack produced no tarball", packed.stdout + packed.stderr, probeDir);
  }

  // 1b. Opt-in: a workspace leaf whose version the floor names but npm lacks
  //     comes from a pack of the workspace (see the header). Never in publish.
  const workspaceDepTarballs: string[] = [];
  if (values["pack-unpublished-workspace-deps"]) {
    const workspaces = await workspacePackages();
    const depsDir = join(probeDir, "workspace-deps");
    await mkdir(depsDir);
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      const ws = workspaces.get(name);
      if (!ws || rangeFloor(range) !== ws.version || (await isOnNpm(name, ws.version))) continue;
      console.log(
        `▸ ${name}@${ws.version} is not on npm yet: installing it from a pack of the ` +
          `workspace (--pack-unpublished-workspace-deps). Publishing ${pkg.name} still ` +
          `requires it on npm — tag the leaf once this merges.`,
      );
      const leafPacked = run(
        ["npm", "pack", "--ignore-scripts", "--silent", "--json", "--pack-destination", depsDir],
        ws.dir,
      );
      if (!leafPacked.ok) {
        fail(
          `npm pack of workspace ${name} failed`,
          leafPacked.stderr || leafPacked.stdout,
          probeDir,
        );
      }
      const [{ filename }] = JSON.parse(leafPacked.stdout) as [{ filename: string }];
      workspaceDepTarballs.push(`./workspace-deps/${filename}`);
    }
  }

  // 2. Throwaway consumer project — no workspaces, outside the monorepo.
  await writeFile(
    join(probeDir, "package.json"),
    `${JSON.stringify(
      {
        name: "appstrate-package-resolution-probe",
        version: "0.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );

  // 3. Install as a consumer would. npm, not bun: bun's workspace resolution
  //    could still link back into the monorepo and re-hide the defect.
  const declaredPeers = pkg.peerDependencies ?? {};
  const baseline: Record<string, string> = {
    typescript: "^5",
    // Bun's ambient types: `engines.bun` makes a Bun toolchain the consumer
    // baseline, and it supplies the `node:*` + `Bun.*` typings our source needs.
    "@types/bun": "latest",
  };
  const installTargets = [
    `./${tarball}`,
    // npm dedupes the target's edge onto these top-level installs, so the
    // registry is never asked for a version it does not have.
    ...workspaceDepTarballs,
    // A declared peer range wins over the baseline default for the same name.
    ...Object.entries({ ...baseline, ...declaredPeers }).map(([n, r]) => `${n}@${r}`),
  ];
  console.log(`▸ npm install ${installTargets.join(" ")}`);
  const installed = run(
    ["npm", "install", "--no-audit", "--no-fund", "--loglevel=error", ...installTargets],
    probeDir,
  );
  if (!installed.ok) {
    fail(
      "npm install of the packed tarball failed",
      installed.stderr || installed.stdout,
      probeDir,
    );
  }

  // 4. Probe importing every subpath. `export * as` keeps each namespace live
  //    (no unused-binding elision) without colliding on re-exported names.
  const probeSource =
    "// Generated by scripts/verify-package-resolves.ts — do not edit.\n" +
    subpaths.map((s, i) => `export * as ns${i} from ${JSON.stringify(s)};`).join("\n") +
    "\n";
  await writeFile(join(probeDir, "probe.ts"), probeSource);

  await writeFile(
    join(probeDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ["ESNext"],
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          moduleDetection: "force",
          // Our source imports siblings with explicit `.ts` extensions.
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          strict: true,
          // Realistic consumer setting: skips third-party `.d.ts`, but NOT the
          // `.ts` source we ship — which is precisely what we want checked.
          skipLibCheck: true,
          types: ["bun"],
        },
        include: ["probe.ts"],
      },
      null,
      2,
    )}\n`,
  );

  // 5. Typecheck with the probe's own tsc.
  console.log("▸ tsc --noEmit (strict) …");
  const tsc = run(
    [join(probeDir, "node_modules", ".bin", "tsc"), "--noEmit", "-p", "tsconfig.json"],
    probeDir,
  );
  if (!tsc.ok) {
    keepDir = true;
    fail(
      `${pkg.name} does not typecheck in a clean consumer install`,
      tsc.stdout || tsc.stderr,
      probeDir,
    );
  }

  console.log("");
  console.log(
    `✅ ${pkg.name}@${pkg.version} resolves cleanly for consumers — ` +
      `${subpaths.length} subpaths typechecked under strict in an isolated npm install.`,
  );
} finally {
  if (keepDir) {
    console.log(`▸ probe kept at ${probeDir}`);
  } else {
    await rm(probeDir, { recursive: true, force: true });
  }
}
