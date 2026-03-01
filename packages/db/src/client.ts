import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";
import { getEnv } from "@appstrate/env";

const { DATABASE_URL } = getEnv();

// Main query connection pool
const queryClient = postgres(DATABASE_URL, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 30,
  max_lifetime: 60 * 30,
});

// Drizzle ORM instance with schema for relational queries
export const db = drizzle(queryClient, { schema });

// Export type for dependency injection
export type Db = typeof db;

// Dedicated LISTEN connection (single, long-lived, no pooling)
export const listenClient = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 0,
  max_lifetime: 0,
});

// Graceful shutdown
export async function closeDb(): Promise<void> {
  await queryClient.end();
  await listenClient.end();
}
