// SPDX-License-Identifier: Apache-2.0

/**
 * Build or validate AFPS archives for all system packages.
 *
 * Sources:  scripts/system-packages/{type}-{name}-{version}/
 * Output:   system-packages/{type}-{name}-{version}.afps
 *
 * Discovers every package source directory regardless of type — both
 * `integration-*` (AFPS integration manifests) and `mcp-server-*` (MCPB
 * manifests with the AFPS identity contract lifted to the root per AFPS
 * §3.4 — `type: "mcp-server"`, `name`, `schema_version` all at the
 * top level). `validateManifest` dispatches by root `type`, so the loop
 * below is type-agnostic.
 *
 * Each source directory must contain a manifest.json. All files in the
 * directory are bundled into the archive.
 *
 * These sources are the reference manifests authors copy, so every one must
 * declare the `schema_version` the platform writes (`AFPS_SCHEMA_VERSION`).
 * Reading stays lenient on purpose — any 0.x loads — so this build is the
 * only place that notices a spec bump leaving them behind.
 *
 * Usage:
 *   bun run scripts/build-system-packages.ts           # build archives
 *   bun run scripts/build-system-packages.ts --check   # validate only (no write)
 */
import { readdir, readFile, lstat, stat, writeFile, unlink } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { AFPS_SCHEMA_VERSION, validateManifest } from "@appstrate/core/validation";
import { zipArtifact } from "@appstrate/core/zip";
import { computeIntegrity } from "@appstrate/core/integrity";

/**
 * Recursively collect every regular file under `root` into the zip
 * entry map, keyed by POSIX-style relative path. Entries are probed with
 * `lstat` (NOT `stat`) so symlinks are detected rather than followed:
 * a symlink could otherwise dereference a sensitive file (e.g. an
 * absolute link to /etc/shadow or an escape via `../`) and embed its
 * contents into the published AFPS archive. We refuse symlinks outright
 * — system packages are plain file trees and never legitimately need
 * one. Subdirectories named `node_modules` are skipped — they should
 * never be bundled into a system package.
 */
async function collectZipEntries(root: string): Promise<Record<string, Uint8Array>> {
  const entries: Record<string, Uint8Array> = {};
  async function walk(dir: string): Promise<void> {
    const names = await readdir(dir);
    for (const name of names) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      const st = await lstat(full);
      if (st.isSymbolicLink()) {
        throw new Error(
          `Refusing to bundle symlink into a system package: ${relative(root, full)} — ` +
            `symlinks can smuggle files from outside the source tree into the archive. ` +
            `Replace it with a real file.`,
        );
      }
      if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile()) {
        const rel = relative(root, full).split(sep).join(posix.sep);
        entries[rel] = new Uint8Array(await readFile(full));
      }
    }
  }
  await walk(root);
  return entries;
}

/**
 * Every source manifest whose `schema_version` is not `AFPS_SCHEMA_VERSION`,
 * with what it declares (`undefined` when absent). Pure — takes parsed JSON,
 * so it runs before `validateManifest` and on whatever shape the file holds.
 */
export function findSchemaVersionDrift(
  manifests: Iterable<readonly [dirName: string, manifest: unknown]>,
) {
  const drift: { dirName: string; declared: unknown }[] = [];
  for (const [dirName, manifest] of manifests) {
    const declared = (manifest as { schema_version?: unknown } | null)?.schema_version;
    if (declared !== AFPS_SCHEMA_VERSION) drift.push({ dirName, declared });
  }
  return drift;
}

const checkOnly = process.argv.includes("--check");
const SOURCES_DIR = join(import.meta.dir, "system-packages");
const OUTPUT_DIR = join(import.meta.dir, "../system-packages");

async function main() {
  const entries = await readdir(SOURCES_DIR);
  const dirs = entries.filter((e) => !e.startsWith(".") && e !== "node_modules").sort();
  const existingAfps = await readdir(OUTPUT_DIR);
  let count = 0;
  const byType: Record<string, number> = {};

  // Compute the set of archive names that should exist, based on source
  // dirs. Used below to detect orphan `.afps` files (source removed but
  // archive left behind — they would otherwise be loaded at boot and
  // resurface in the UI as "Intégré" packages). Manifests are parsed here,
  // once, so the schema_version guard below runs before anything is written.
  const expectedZips = new Set<string>();
  const manifests = new Map<string, unknown>();
  for (const dirName of dirs) {
    const dirPath = join(SOURCES_DIR, dirName);
    if (!(await stat(dirPath)).isDirectory()) continue;
    expectedZips.add(`${dirName}.afps`);
    manifests.set(dirName, JSON.parse(await readFile(join(dirPath, "manifest.json"), "utf-8")));
  }

  // Both modes, before the orphan sweep: a failing build leaves system-packages/
  // untouched. Every offender is listed so a spec bump names all of them at once.
  const drift = findSchemaVersionDrift(manifests);
  if (drift.length > 0) {
    console.error(
      `\nSCHEMA VERSION: ${drift.length} source manifest(s) in scripts/system-packages/ do not declare schema_version "${AFPS_SCHEMA_VERSION}" (AFPS_SCHEMA_VERSION):`,
    );
    for (const { dirName, declared } of drift) {
      const found = declared === undefined ? "no schema_version" : JSON.stringify(declared);
      console.error(`  - ${dirName}: ${found}, expected "${AFPS_SCHEMA_VERSION}"`);
    }
    console.error(
      `\nSet schema_version to "${AFPS_SCHEMA_VERSION}" in each and, if that version is already\n` +
        `released, bump its patch version (the \`version\` field AND the directory name),\n` +
        `then run \`bun run build:system-packages\`. Released versions are immutable: changed\n` +
        `content under the same version is refused at boot\n` +
        `(apps/api/src/services/system-packages.ts).\n`,
    );
    process.exit(1);
  }

  const orphans = existingAfps.filter((name) => name.endsWith(".afps") && !expectedZips.has(name));
  if (orphans.length > 0) {
    if (checkOnly) {
      console.error(
        `\nORPHAN: ${orphans.length} archive(s) in system-packages/ have no source dir in scripts/system-packages/:`,
      );
      for (const o of orphans) console.error(`  - ${o}`);
      console.error(
        `\nDelete these archives or restore their sources. Orphan archives are\n` +
          `loaded at boot and resurface in the UI as built-in packages.\n`,
      );
      process.exit(1);
    }
    for (const o of orphans) {
      await unlink(join(OUTPUT_DIR, o));
      console.log(`  Deleted orphan: ${o}`);
    }
  }

  for (const [dirName, parsed] of manifests) {
    const dirPath = join(SOURCES_DIR, dirName);

    const result = validateManifest(parsed);
    if (!result.valid) {
      console.error(`INVALID: ${dirName}/manifest.json — ${result.errors.join(", ")}`);
      process.exit(1);
    }

    const manifest = result.manifest;
    // AFPS (§3.4) lifted mcp-server identity to the manifest root, so
    // every package type now declares its `type` at the top level.
    const type = (manifest.type as string | undefined) ?? "unknown";
    byType[type] = (byType[type] ?? 0) + 1;

    // Bundle every file in the source dir (recursively). Subdirectory
    // paths like `server/index.ts` keep their structure inside the
    // archive so a manifest `entry_point: "server/index.ts"` resolves
    // against the extracted bundle root at runtime.
    const zipEntries = await collectZipEntries(dirPath);

    const zipBytes: Uint8Array = zipArtifact(zipEntries);

    if (checkOnly) {
      // Drift guard: the committed archive must be byte-identical to a fresh
      // build of its source. `zipArtifact` is deterministic (fixed mtime), so
      // any difference means someone edited the source dir without rebuilding
      // — the platform would load the stale archive at boot.
      const zipName = `${dirName}.afps`;
      if (!existingAfps.includes(zipName)) {
        console.error(
          `MISSING ARCHIVE: ${zipName} — run \`bun run build:system-packages\` and commit it.`,
        );
        process.exit(1);
      }
      const onDisk = new Uint8Array(await readFile(join(OUTPUT_DIR, zipName)));
      if (onDisk.byteLength !== zipBytes.byteLength || Buffer.compare(onDisk, zipBytes) !== 0) {
        console.error(
          `STALE ARCHIVE: ${zipName} differs from its source dir — run \`bun run build:system-packages\` and commit the rebuilt archive.`,
        );
        process.exit(1);
      }
      console.log(`  ${dirName} [${type}] ✓`);
      count++;
      continue;
    }

    // Delete the existing archive for this exact version, if any. Other
    // versions of the same package live in sibling source dirs and must
    // be preserved.
    const zipName = `${dirName}.afps`;
    if (existingAfps.includes(zipName)) {
      await unlink(join(OUTPUT_DIR, zipName));
      console.log(`  Deleted old: ${zipName}`);
    }

    // Build archive
    const integrity = computeIntegrity(zipBytes);

    await writeFile(join(OUTPUT_DIR, zipName), zipBytes);
    console.log(`  ${zipName} (${zipBytes.byteLength} bytes) ${integrity}`);
    count++;
  }

  const breakdown = Object.entries(byType)
    .sort()
    .map(([t, n]) => `${n} ${t}`)
    .join(", ");
  console.log(
    `\n${count} system packages ${checkOnly ? "validated" : "built"}${breakdown ? ` (${breakdown})` : ""}`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
