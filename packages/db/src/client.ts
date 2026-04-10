// SPDX-License-Identifier: Apache-2.0

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { getEnv } from "@appstrate/env";
import * as schema from "./schema.ts";

const env = getEnv();

/** True when using PGlite (embedded Postgres) instead of external PostgreSQL. */
export const isEmbeddedDb = !env.DATABASE_URL;

/** Portable Drizzle PG database type — works with both postgres.js and PGlite. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Postgres.js listen client or PGlite notification handler. */
export interface ListenClient {
  listen(channel: string, handler: (payload: string) => void): Promise<void>;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

let _closeDb: (() => Promise<void>) | null = null;
let _listenClient: ListenClient | null = null;
let _pgliteClient: import("@electric-sql/pglite").PGlite | null = null;
let _pgQueryClient: import("postgres").Sql | null = null;

/** Access the raw PGlite client (for exec() multi-statement support). Only available in embedded mode. */
export function getPGliteClient(): import("@electric-sql/pglite").PGlite | null {
  return _pgliteClient;
}

async function initPGlite(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { resolve } = await import("node:path");
  const { mkdirSync } = await import("node:fs");

  const dataDir = resolve(env.PGLITE_DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);

  _pgliteClient = client;
  _closeDb = () => client.close();
  _listenClient = {
    listen: async (channel, handler) => {
      await client.listen(channel, handler);
    },
  };

  return drizzle(client, { schema }) as unknown as Db;
}

async function initPostgres(): Promise<Db> {
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");

  const queryClient = postgres(env.DATABASE_URL!, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 30,
    max_lifetime: 60 * 30,
  });
  _pgQueryClient = queryClient;

  const listenConn = postgres(env.DATABASE_URL!, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
  });

  _closeDb = async () => {
    await queryClient.end();
    await listenConn.end();
  };
  _listenClient = {
    listen: (channel, handler) => listenConn.listen(channel, handler) as unknown as Promise<void>,
  };

  return drizzle(queryClient, { schema }) as unknown as Db;
}

// Top-level await — Bun supports this natively in ESM
export const db: Db = await (isEmbeddedDb ? initPGlite() : initPostgres());

export function getListenClient(): ListenClient {
  return _listenClient!;
}

export const listenClient: ListenClient = {
  listen: (channel, handler) => getListenClient().listen(channel, handler),
};

export async function closeDb(): Promise<void> {
  if (_closeDb) await _closeDb();
  _closeDb = null;
  _listenClient = null;
  _pgliteClient = null;
  _pgQueryClient = null;
}

/**
 * Reserve a single PostgreSQL connection from the pool for session-scoped
 * primitives like `pg_advisory_lock` — lock acquisition and release MUST hit
 * the same backend connection, otherwise the unlock targets a different
 * session (silent no-op) and the original session holds the lock forever.
 *
 * Returns `null` in PGlite mode. Caller MUST invoke `release()` in a `finally`
 * block or the pool will leak (max 20 connections).
 *
 * The reserved sql is a raw postgres-js instance (not wrapped in Drizzle) so
 * callers use tagged-template syntax: `await sql\`SELECT pg_advisory_lock(${k})\``.
 * Protected work can run on any connection — the lock only needs to be held
 * by *someone* to block concurrent callers.
 */
export async function reservePgConnection(): Promise<{
  sql: import("postgres").ReservedSql;
  release: () => void;
} | null> {
  if (isEmbeddedDb || !_pgQueryClient) return null;
  const reserved = await _pgQueryClient.reserve();
  return { sql: reserved, release: () => reserved.release() };
}
