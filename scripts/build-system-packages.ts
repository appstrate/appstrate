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

const checkOnly = process.argv.includes("--check");
const SOURCES_DIR = join(import.meta.dir, "system-packages");
const OUTPUT_DIR = join(import.meta.dir, "../system-packages");

async function main() {
  const entries = await readdir(SOURCES_DIR);
  const dirs = entries.filter((e) => !e.startsWith(".") && e !== "node_modules");
  const existingAfps = checkOnly ? [] : await readdir(OUTPUT_DIR);
  let count = 0;

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

    if (checkOnly) {
      console.log(`  ${dirName} [${type}] ✓`);
      count++;
      continue;
    }

    // Collect all files
    const files = await readdir(dirPath);
    const zipEntries: Record<string, Uint8Array> = {};
    for (const file of files) {
      const filePath = join(dirPath, file);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
      zipEntries[file] = new Uint8Array(await readFile(filePath));
    }

    // Delete old archives for this package
    const baseName = dirName.replace(/-\d+\.\d+\.\d+$/, "");
    for (const f of existingAfps) {
      if (f.endsWith(".afps") && f.startsWith(`${baseName}-`)) {
        await unlink(join(OUTPUT_DIR, f));
        console.log(`  Deleted old: ${f}`);
      }
    }

    // Build archive
    const zipName = `${dirName}.afps`;
    const zipBytes = zipArtifact(zipEntries);
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
