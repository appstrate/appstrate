import { defineConfig } from "drizzle-kit";
import { getEnv } from "@appstrate/env";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: getEnv().DATABASE_URL,
  },
});
