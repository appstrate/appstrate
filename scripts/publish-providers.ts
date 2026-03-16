/**
 * Publish system provider AFPS packages to the Appstrate registry.
 *
 * For each apps/api/providers/{name}/{name}-{version}.afps:
 *   1. Read the pre-built ZIP
 *   2. Compute SHA256 SRI integrity
 *   3. Parse manifest from ZIP
 *   4. Check registry: does @appstrate/{name}@{version} exist with same integrity?
 *      - Yes → skip
 *      - No → publish via registry client
 *   5. Log results
 *
 * Usage: REGISTRY_URL=... REGISTRY_TOKEN=... bun run scripts/publish-providers.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { computeIntegrity } from "@appstrate/core/integrity";
import { parsePackageZip } from "@appstrate/core/zip";

const PROVIDERS_DIR = join(import.meta.dir, "../apps/api/providers");

const registryUrl = process.env.REGISTRY_URL;
const registryToken = process.env.REGISTRY_TOKEN;

if (!registryUrl || !registryToken) {
  console.error("Required: REGISTRY_URL and REGISTRY_TOKEN environment variables");
  process.exit(1);
}

async function main() {
  const entries = await readdir(PROVIDERS_DIR);
  let published = 0;
  let skipped = 0;

  for (const entry of entries.sort()) {
    const entryDir = join(PROVIDERS_DIR, entry);
    const files = await readdir(entryDir);
    const zipFile = files.find((f) => f.endsWith(".afps"));
    if (!zipFile) continue;

    const zipBuffer = await readFile(join(entryDir, zipFile));
    const integrity = computeIntegrity(new Uint8Array(zipBuffer));
    const parsed = parsePackageZip(new Uint8Array(zipBuffer));
    const manifest = parsed.manifest;
    const scope = "@appstrate";
    const name = entry;
    const version = manifest.version as string;

    // Check if already published with same integrity
    try {
      const res = await fetch(`${registryUrl}/api/packages/${scope}/${name}`, {
        headers: { Authorization: `Bearer ${registryToken}` },
      });

      if (res.ok) {
        const pkg = (await res.json()) as {
          versions: { version: string; integrity: string }[];
        };
        const existing = pkg.versions.find((v) => v.version === version);
        if (existing?.integrity === integrity) {
          console.log(`  SKIP ${scope}/${name}@${version} (already published, same integrity)`);
          skipped++;
          continue;
        }
      }
    } catch {
      // Registry not reachable or package not found — proceed to publish
    }

    // Publish
    const formData = new FormData();
    formData.append("artifact", new Blob([zipBuffer]), `${name}-${version}.afps`);

    const publishRes = await fetch(`${registryUrl}/api/packages/${scope}/${name}/publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${registryToken}` },
      body: formData,
    });

    if (publishRes.ok) {
      console.log(`  PUBLISHED ${scope}/${name}@${version} ${integrity}`);
      published++;
    } else {
      const body = await publishRes.text();
      console.error(`  FAILED ${scope}/${name}@${version}: ${publishRes.status} ${body}`);
    }
  }

  console.log(`\nPublished: ${published}, Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
