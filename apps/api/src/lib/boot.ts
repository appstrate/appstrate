// SPDX-License-Identifier: Apache-2.0

import { and, eq } from "drizzle-orm";
import { db, isEmbeddedDb, getPGliteClient, reservePgConnection } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import { expireOldInvitations } from "../services/invitations.ts";
import { cleanupExpiredKeys } from "../services/api-keys.ts";
import { cleanupExpiredUploads } from "../services/uploads.ts";
import { createNotifyTriggers } from "@appstrate/db/notify";
import { logger } from "./logger.ts";
import { loadModules, getModules, getModuleContributions } from "./modules/module-loader.ts";
import { getModuleRegistry, buildModuleInitContext } from "./modules/registry.ts";
import { registerEmailOverrides } from "@appstrate/emails";
import {
  setBeforeSignupHook,
  setAfterSignupHook,
  createAuth,
  type BetterAuthPluginList,
} from "@appstrate/db/auth";
import { initRealtime } from "../services/realtime.ts";
import { initSystemProxies } from "../services/proxy-registry.ts";
import { initSystemProviderKeys } from "../services/model-registry.ts";
import {
  initSystemPackages,
  getSystemPackages,
  type SystemPackageEntry,
} from "../services/system-packages.ts";
import { createVersionAndUpload } from "../services/package-versions.ts";
import {
  uploadPackageFiles,
  SYSTEM_STORAGE_NAMESPACE,
  storageFolderForType,
} from "../services/package-items/index.ts";
import { markOrphanRunsFailed } from "../services/state/index.ts";
import { initScheduleWorker } from "../services/scheduler.ts";
import { initCancelSubscriber } from "../services/run-tracker.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { ensureBucket } from "@appstrate/db/storage";
import { logInfraMode } from "../infra/index.ts";

export async function boot(): Promise<void> {
  // Apply core migrations at boot (before modules, so DB is ready).
  // Both PGlite and PostgreSQL auto-migrate — no manual `db:migrate` step needed.
  const env = (await import("@appstrate/env")).getEnv();
  if (isEmbeddedDb) {
    logger.info("Database: PGlite (embedded)", { path: env.PGLITE_DATA_DIR });
    await applyEmbeddedMigrations();
  } else {
    logger.info("Database: PostgreSQL", {
      url: env.DATABASE_URL?.replace(/\/\/.*@/, "//***@") ?? "",
    });
    await applyCoreMigrations();
  }

  // Load modules (cloud, webhooks, etc.)
  // Modules may run their own migrations in init() — core DB is ready.
  await loadModules(getModuleRegistry(), buildModuleInitContext());

  // Initialize Better Auth AFTER modules have registered their plugin +
  // schema contributions. `createAuth()` narrows the `unknown[]` from the
  // core contract to Better Auth's plugin list type, and merges module
  // Drizzle schemas into the adapter's model map so plugins like
  // @better-auth/oauth-provider can resolve their own tables.
  const contributions = getModuleContributions();
  createAuth(contributions.betterAuthPlugins as BetterAuthPluginList, contributions.drizzleSchemas);

  // Wire module contributions that were declared on the module contract
  for (const mod of getModules().values()) {
    if (mod.emailOverrides) {
      registerEmailOverrides(mod.emailOverrides);
    }
  }
  // Broadcast `beforeSignup` to EVERY loaded module (not first-match-wins
  // like other hooks). The cloud module's free-tier gate AND the OIDC
  // module's per-client signup policy both need to run on every signup;
  // first throw aborts the user creation. Iteration is inline (rather
  // than going through `callHook`) because the semantics differ from the
  // generic first-match-wins path in `module-loader.ts`.
  setBeforeSignupHook(async (email, ctx) => {
    for (const mod of getModules().values()) {
      const hook = mod.hooks?.beforeSignup;
      if (hook) await hook(email, ctx);
    }
  });
  // Broadcast `afterSignup` to every loaded module too — OIDC uses it to
  // auto-join the newly created user to the org pinned by the in-flight
  // OAuth client so the onward /authorize redirect completes cleanly.
  setAfterSignupHook(async (user, ctx) => {
    for (const mod of getModules().values()) {
      const hook = mod.hooks?.afterSignup;
      if (hook) await hook(user, ctx);
    }
  });
  if (env.S3_BUCKET) {
    logger.info("Storage: S3", { bucket: env.S3_BUCKET, endpoint: env.S3_ENDPOINT ?? "AWS" });
  } else {
    logger.info("Storage: filesystem", { path: env.FS_STORAGE_PATH });
  }
  logInfraMode();

  // Verify storage backend is accessible (fail-fast if misconfigured)
  await ensureBucket();

  // Load system proxies from SYSTEM_PROXIES env var
  initSystemProxies();
  logger.info("System proxies loaded");

  // Load system provider keys + models from SYSTEM_PROVIDER_KEYS env var
  initSystemProviderKeys();
  logger.info("System provider keys loaded");

  // Load system packages from ZIPs, sync to DB + S3
  await loadAndSyncSystemPackages().catch((err) => {
    logger.warn("Could not load/sync system packages", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Parallel init: NOTIFY triggers and realtime are independent
  await Promise.all([
    createNotifyTriggers(db)
      .then(() => logger.info("NOTIFY triggers installed"))
      .catch((err) => {
        logger.warn("Could not install NOTIFY triggers", {
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    initRealtime().catch((err) => {
      logger.warn("Could not initialize realtime LISTEN", {
        error: err instanceof Error ? err.message : String(err),
      });
    }),
  ]);

  // Sequential cleanup: orphan runs must be marked before container cleanup,
  // and containers must be cleaned before sidecar pool init.
  try {
    const { count, runIds } = await markOrphanRunsFailed();
    if (count > 0) {
      logger.info("Marked orphaned runs as failed", { count, runIds });
    }
  } catch (err) {
    logger.warn("Could not clean orphaned runs", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const orchestrator = getOrchestrator();
  try {
    const report = await orchestrator.cleanupOrphans();
    if (report.workloads > 0 || report.isolationBoundaries > 0) {
      logger.info("Cleaned up orphaned resources", { ...report });
    }
  } catch (err) {
    logger.warn("Could not clean up orphaned resources", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Initialize cross-instance cancel subscriber
  await initCancelSubscriber();

  // Parallel init: sidecar pool, scheduler, and DB cleanups are all independent
  const parallelInits: Promise<void>[] = [
    orchestrator.initialize().catch((err) => {
      logger.warn("Could not initialize sidecar pool", {
        error: err instanceof Error ? err.message : String(err),
      });
    }),
    initScheduleWorker().catch((err) => {
      logger.warn("Could not initialize schedule worker", {
        error: err instanceof Error ? err.message : String(err),
      });
    }),
    expireOldInvitations()
      .then((expiredCount) => {
        if (expiredCount > 0) logger.info("Expired old invitations", { count: expiredCount });
      })
      .catch((err) => {
        logger.warn("Could not expire old invitations", {
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    cleanupExpiredKeys()
      .then((expiredKeyCount) => {
        if (expiredKeyCount > 0)
          logger.info("Revoked expired API keys", { count: expiredKeyCount });
      })
      .catch((err) => {
        logger.warn("Could not clean up expired API keys", {
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    cleanupExpiredUploads()
      .then((count) => {
        if (count > 0) logger.info("Removed expired unconsumed uploads", { count });
      })
      .catch((err) => {
        logger.warn("Could not clean up expired uploads", {
          error: err instanceof Error ? err.message : String(err),
        });
      }),
  ];

  await Promise.all(parallelInits);
}

/**
 * Load system packages from ZIPs on disk, then sync to DB + S3.
 * Upserts packages rows (source: "system"), uploads files to global _system/ namespace,
 * and creates packageVersions with SHA256 SRI integrity.
 */
async function loadAndSyncSystemPackages(): Promise<void> {
  await initSystemPackages();
  const allPackages = getSystemPackages();
  if (allPackages.size === 0) return;

  let synced = 0;

  const syncOne = async (id: string, entry: SystemPackageEntry) => {
    const { manifest, zipBuffer, type } = entry;
    const version = manifest.version as string;

    // Check if this exact version already exists (nothing changed since last boot)
    const [existingVersion] = await db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, id), eq(packageVersions.version, version)))
      .limit(1);

    const isNewVersion = !existingVersion;

    // 1. UPSERT packages row (source: "system", orgId: null — global)
    await db
      .insert(packages)
      .values({
        id,
        orgId: null,
        type,
        source: "system",
        draftManifest: manifest as unknown as Record<string, unknown>,
        draftContent: entry.content,
      })
      .onConflictDoUpdate({
        target: packages.id,
        set: {
          draftManifest: manifest as unknown as Record<string, unknown>,
          draftContent: entry.content,
          source: "system",
          orgId: null,
          ...(isNewVersion ? { updatedAt: new Date() } : {}),
        },
      });

    // 2. Upload system package files to global _system/ namespace (once, not per-org)
    if (Object.keys(entry.files).length > 1) {
      await uploadPackageFiles(
        storageFolderForType(type),
        SYSTEM_STORAGE_NAMESPACE,
        id,
        entry.files,
      );
    }

    // 3. Create version from pre-built ZIP (idempotent — skips if version exists)
    await createVersionAndUpload({
      packageId: id,
      version,
      createdBy: null,
      zipBuffer,
      manifest: manifest as unknown as Record<string, unknown>,
    });

    synced++;
  };

  // Sync all system packages concurrently (per-package error isolation)
  await Promise.all(
    Array.from(allPackages).map(([id, entry]) =>
      syncOne(id, entry).catch((err) => {
        logger.warn("Failed to sync system package", {
          packageId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    ),
  );

  logger.info("System packages synced", { packages: synced });
}

/**
 * Apply Drizzle migrations programmatically for PGlite (embedded mode).
 * Uses a custom migrator that splits multi-statement SQL files into individual
 * statements, since PGlite does not support multi-statement prepared queries.
 */
async function applyEmbeddedMigrations(): Promise<void> {
  const { resolve, join } = await import("node:path");
  const { readFileSync, existsSync } = await import("node:fs");

  const migrationsDir = resolve(import.meta.dir, "../../../../packages/db/drizzle");
  const journalPath = join(migrationsDir, "meta/_journal.json");

  if (!existsSync(journalPath)) {
    logger.warn("No migration journal found, skipping PGlite migrations");
    return;
  }

  const pg = getPGliteClient()!;

  // Create migrations tracking table
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)
    )
  `);

  // Read journal to get migration order
  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
    entries: { idx: number; tag: string }[];
  };

  // Get already-applied migrations
  const { rows } = await pg.query<{ hash: string }>('SELECT hash FROM "__drizzle_migrations"');
  const applied = new Set(rows.map((r) => r.hash));

  for (const entry of journal.entries) {
    if (applied.has(entry.tag)) continue;

    const sqlFile = join(migrationsDir, `${entry.tag}.sql`);
    if (!existsSync(sqlFile)) {
      logger.warn("Migration file not found, skipping", { tag: entry.tag });
      continue;
    }

    const content = readFileSync(sqlFile, "utf-8");
    // PGlite exec() supports multi-statement SQL natively
    await pg.exec(content.replaceAll("--> statement-breakpoint", ""));
    // Record migration as applied
    await pg.query('INSERT INTO "__drizzle_migrations" (hash) VALUES ($1)', [entry.tag]);
  }

  logger.info("PGlite migrations applied", { count: journal.entries.length - applied.size });
}

/**
 * Apply Drizzle migrations for PostgreSQL using the standard migrator.
 * Idempotent — already-applied migrations are skipped via the tracking table.
 *
 * Multi-replica safety: drizzle-orm's migrator does not take a lock, so two
 * API replicas starting simultaneously can race on `__drizzle_migrations`.
 * We wrap the whole migration in a PostgreSQL session-level advisory lock
 * using a stable constant key (shared across all replicas). A second caller
 * blocks until the first finishes, then observes its entries in the tracking
 * table and skips them.
 *
 * pg_advisory_lock is session-scoped: the lock and unlock must target the
 * same backend connection. We pin them to a reserved postgres-js connection;
 * the migrator runs on the shared pool since holding the lock elsewhere is
 * enough to block concurrent replicas.
 */
const APPSTRATE_CORE_MIGRATION_LOCK_KEY = 7246811234567890n;

async function applyCoreMigrations(): Promise<void> {
  const { resolve } = await import("node:path");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { sql: rawSql } = await import("drizzle-orm");

  const migrationsFolder = resolve(import.meta.dir, "../../../../packages/db/drizzle");

  const reserved = await reservePgConnection();
  if (!reserved) {
    throw new Error("reservePgConnection() returned null — expected PostgreSQL client");
  }
  const { sql: reservedSql, release } = reserved;

  try {
    await reservedSql`SELECT pg_advisory_lock(${String(APPSTRATE_CORE_MIGRATION_LOCK_KEY)}::bigint)`;
    try {
      await db.execute(rawSql`SET client_min_messages TO 'warning'`);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema generic widening for migrator
        await migrate(db as any, { migrationsFolder });
      } finally {
        await db.execute(rawSql`SET client_min_messages TO 'notice'`);
      }
    } finally {
      await reservedSql`SELECT pg_advisory_unlock(${String(APPSTRATE_CORE_MIGRATION_LOCK_KEY)}::bigint)`;
    }
  } finally {
    release();
  }
  logger.info("Core migrations applied");
}
