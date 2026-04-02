// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "drizzle-kit";
import { resolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load .env from monorepo root if DATABASE_URL is not already set.
// Bun auto-loads .env from CWD, but drizzle-kit runs from packages/db/
// via "cd packages/db && bunx drizzle-kit", so the root .env is missed.
// drizzle-kit transpiles this config to CJS, so import.meta may be empty.
if (!process.env["DATABASE_URL"]) {
  const dir =
    typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(dir, "../../.env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      const value = trimmed.slice(eq + 1);
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

// Read DATABASE_URL directly from process.env to avoid importing @appstrate/env,
// which transitively imports @appstrate/core (.ts source in node_modules) that
// drizzle-kit's Node-based config loader cannot handle.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env["DATABASE_URL"]!,
  },
});
