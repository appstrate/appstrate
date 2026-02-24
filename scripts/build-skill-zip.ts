/**
 * Build the appstrate-api-guide skill ZIP for public download.
 *
 * Usage: bun run scripts/build-skill-zip.ts
 *
 * Reads files from apps/web/public/assets/appstrate-api-guide/
 * and produces   apps/web/public/assets/appstrate-api-guide.zip
 */

import { join } from "node:path";

const ASSETS_DIR = join(import.meta.dir, "..", "apps", "web", "public", "assets");
const OUTPUT = join(ASSETS_DIR, "appstrate-api-guide.zip");

async function main() {
  // Remove existing ZIP if present
  const existing = Bun.file(OUTPUT);
  if (await existing.exists()) {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(OUTPUT);
  }

  const proc = Bun.spawnSync(["zip", "-r", "appstrate-api-guide.zip", "appstrate-api-guide/"], {
    cwd: ASSETS_DIR,
  });

  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
    process.exit(1);
  }

  const stat = Bun.file(OUTPUT);
  console.log(`Created ${OUTPUT} (${((await stat.size) / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
