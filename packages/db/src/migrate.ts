import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createLogger } from "@appstrate/core/logger";

const logger = createLogger("info");

const url = process.env["DATABASE_URL"];
if (!url) {
  logger.error("DATABASE_URL is required");
  process.exit(1);
}

const client = postgres(url, { max: 1 });
const db = drizzle(client);

logger.info("Running migrations...");
await migrate(db, { migrationsFolder: "./packages/db/drizzle" });
logger.info("Migrations complete");

await client.end();
