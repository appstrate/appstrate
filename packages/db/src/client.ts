import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

if (!process.env.DATABASE_URL) {
  console.warn("[db] DATABASE_URL not set, using default local connection");
}

// Main query connection pool
const queryClient = postgres(process.env.DATABASE_URL!, {
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
export const listenClient = postgres(process.env.DATABASE_URL!, {
  max: 1,
  idle_timeout: 0,
  max_lifetime: 0,
});

// Raw sql connection for direct queries
export { queryClient as sql };

// Factory for testability
export function createDb(connectionString: string) {
  const client = postgres(connectionString, { max: 10 });
  return drizzle(client, { schema });
}

// Graceful shutdown
export async function closeDb(): Promise<void> {
  await queryClient.end();
  await listenClient.end();
}
