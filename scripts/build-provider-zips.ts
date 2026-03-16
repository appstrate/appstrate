/**
 * Build pre-built AFPS artifacts for system providers.
 *
 * Two modes per provider:
 *   - If a {name}.json source file exists → validate, create AFPS, delete old archives
 *   - If only an AFPS exists → extract manifest, revalidate, rebuild AFPS
 *
 * New providers: create a {name}.json file in apps/api/providers/ and run this script.
 * The source file is deleted after successful build (the AFPS archive is the artifact).
 *
 * Output: apps/api/providers/{name}-{version}.afps
 *
 * Usage: bun run scripts/build-provider-zips.ts
 */
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { validateManifest } from "@appstrate/core/validation";
import { zipArtifact, parsePackageZip } from "@appstrate/core/zip";
import { computeIntegrity } from "@appstrate/core/integrity";

const PROVIDERS_DIR = join(import.meta.dir, "../apps/api/providers");

async function main() {
  const entries = await readdir(PROVIDERS_DIR);
  let built = 0;

  // Collect source manifests (.json files)
  const sourceFiles = entries.filter((f) => f.endsWith(".json"));
  const processedNames = new Set<string>();

  // Phase 1: Build from source .json files
  for (const sourceFile of sourceFiles.sort()) {
    const name = sourceFile.replace(/\.json$/, "");
    const raw = await readFile(join(PROVIDERS_DIR, sourceFile), "utf-8");
    const parsed = JSON.parse(raw);
    const result = validateManifest(parsed);
    if (!result.valid) {
      console.error(`INVALID: ${sourceFile} — ${result.errors.join(", ")}`);
      process.exit(1);
    }

    const manifest = result.manifest;
    const version = manifest.version as string;
    const zipName = `${name}-${version}.afps`;

    // Delete old ZIPs for this provider
    for (const f of entries) {
      if (f.endsWith(".afps") && f.startsWith(`${name}-`) && f !== zipName) {
        await unlink(join(PROVIDERS_DIR, f));
        console.log(`  Deleted old: ${f}`);
      }
    }

    // Create ZIP containing only manifest.json
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    const zipBytes = zipArtifact({ "manifest.json": manifestBytes });
    const integrity = computeIntegrity(zipBytes);

    await writeFile(join(PROVIDERS_DIR, zipName), zipBytes);
    // Remove source file — ZIP is the artifact
    await unlink(join(PROVIDERS_DIR, sourceFile));

    console.log(`  ${zipName} (${zipBytes.byteLength} bytes) ${integrity}`);
    processedNames.add(name);
    built++;
  }

  // Phase 2: Rebuild existing ZIPs (revalidate)
  const zipFiles = entries.filter((f) => f.endsWith(".afps"));
  for (const zipFile of zipFiles.sort()) {
    const name = zipFile.replace(/-\d+\.\d+\.\d+\.afps$/, "");
    if (processedNames.has(name)) continue;

    const buf = await readFile(join(PROVIDERS_DIR, zipFile));
    const pkg = parsePackageZip(new Uint8Array(buf));
    const result = validateManifest(pkg.manifest);
    if (!result.valid) {
      console.error(`INVALID ZIP: ${zipFile} — ${result.errors.join(", ")}`);
      process.exit(1);
    }

    const version = result.manifest.version as string;
    const integrity = computeIntegrity(new Uint8Array(buf));
    console.log(`  ${zipFile} (${buf.byteLength} bytes) ${integrity} [validated]`);
    processedNames.add(name);
    built++;
  }

  console.log(`\n${built} provider AFPS packages ready`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
