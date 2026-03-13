import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { getEnv } from "@appstrate/env";

const url = getEnv().DATABASE_URL;

const client = postgres(url, { max: 1 });
const db = drizzle(client);

console.log("Running migrations...");
await migrate(db, { migrationsFolder: "./packages/db/drizzle" });
console.log("Migrations complete");

await client.end();
