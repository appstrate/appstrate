import { defineConfig } from "drizzle-kit";

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
