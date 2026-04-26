// SPDX-License-Identifier: Apache-2.0

/**
 * Build or validate AFPS archives for all system packages.
 *
 * Sources:  scripts/system-packages/{type}-{name}-{version}/
 * Output:   system-packages/{type}-{name}-{version}.afps
 *
 * Each source directory must contain a manifest.json. All files in the
 * directory are bundled into the archive. Tool packages also get their
 * entrypoint source validated.
 *
 * Usage:
 *   bun run scripts/build-system-packages.ts           # build archives
 *   bun run scripts/build-system-packages.ts --check   # validate only (no write)
 */
import { readdir, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { validateManifest, validateToolSource } from "@appstrate/core/validation";
import { zipArtifact } from "@appstrate/core/zip";
import { computeIntegrity } from "@appstrate/core/integrity";
import { buildPublishedToolArchive } from "@appstrate/core/tool-bundler";

const checkOnly = process.argv.includes("--check");
const SOURCES_DIR = join(import.meta.dir, "system-packages");
const OUTPUT_DIR = join(import.meta.dir, "../system-packages");

async function main() {
  const entries = await readdir(SOURCES_DIR);
  const dirs = entries.filter((e) => !e.startsWith(".") && e !== "node_modules");
  const existingAfps = await readdir(OUTPUT_DIR);
  let count = 0;

  // Compute the set of archive names that should exist, based on source
  // dirs. Used below to detect orphan `.afps` files (source removed but
  // archive left behind — they would otherwise be loaded at boot and
  // resurface in the UI as "Intégré" packages).
  const expectedZips = new Set<string>();
  for (const dirName of dirs) {
    const dirStat = await stat(join(SOURCES_DIR, dirName));
    if (dirStat.isDirectory()) expectedZips.add(`${dirName}.afps`);
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

  for (const dirName of dirs.sort()) {
    const dirPath = join(SOURCES_DIR, dirName);
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) continue;

    // Read and validate manifest
    const manifestRaw = await readFile(join(dirPath, "manifest.json"), "utf-8");
    const parsed = JSON.parse(manifestRaw);
    const result = validateManifest(parsed);
    if (!result.valid) {
      console.error(`INVALID: ${dirName}/manifest.json — ${result.errors.join(", ")}`);
      process.exit(1);
    }

    const manifest = result.manifest;
    const type = manifest.type as string;

    // Tool-specific: validate entrypoint source
    if (type === "tool") {
      const entrypoint = (manifest as Record<string, unknown>).entrypoint as string;
      const source = await readFile(join(dirPath, entrypoint), "utf-8");
      const toolValidation = validateToolSource(source);
      if (!toolValidation.valid) {
        console.error(
          `INVALID SOURCE: ${dirName}/${entrypoint} — ${toolValidation.errors.join(", ")}`,
        );
        process.exit(1);
      }
      for (const w of toolValidation.warnings) {
        console.warn(`  WARN: ${dirName}/${entrypoint} — ${w}`);
      }
    }

    // Collect all files — needed for bundling (tools) and zipping (all types)
    const files = await readdir(dirPath);
    const zipEntries: Record<string, Uint8Array> = {};
    for (const file of files) {
      const filePath = join(dirPath, file);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
      zipEntries[file] = new Uint8Array(await readFile(filePath));
    }

    // Tool-specific: rebundle via the same helper used by the API
    // publish path so system packages ship the identical §3.4 archive
    // layout (self-contained `tool.js` + rewritten entrypoint). Run
    // this even in --check mode so CI catches tools that won't bundle.
    let zipBytes: Uint8Array;
    if (type === "tool") {
      const toolId = (manifest as Record<string, unknown>).name as string;
      const built = await buildPublishedToolArchive({
        files: zipEntries,
        manifest: manifest as Record<string, unknown>,
        toolId,
      });
      zipBytes = built.archive;
    } else {
      zipBytes = zipArtifact(zipEntries);
    }

    if (checkOnly) {
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

  console.log(`\n${count} system packages ${checkOnly ? "validated" : "built"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
