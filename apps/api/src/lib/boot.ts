// SPDX-License-Identifier: Apache-2.0

import { and, eq } from "drizzle-orm";
import { db, isEmbeddedDb, getPGliteClient, reservePgConnection } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import { expireOldInvitations } from "../services/invitations.ts";
import { cleanupExpiredKeys } from "../services/api-keys.ts";
import { cleanupExpiredUploads, startUploadGc } from "../services/uploads.ts";
import { createNotifyTriggers } from "@appstrate/db/notify";
import { logger } from "./logger.ts";
import { loadModules, getModules, getModuleContributions } from "./modules/module-loader.ts";
import { getModuleRegistry, buildModuleInitContext } from "./modules/registry.ts";
import { registerEmailOverrides } from "@appstrate/emails";
import {
  setBeforeSignupHook,
  setAfterSignupHook,
  setPostBootstrapOrgHook,
  createAuth,
  type BetterAuthPluginList,
} from "@appstrate/db/auth";
import { triggerPostBootstrapOrg } from "./post-bootstrap-hook.ts";
import { initRealtime } from "../services/realtime.ts";
import { initSystemProxies } from "../services/proxy-registry.ts";
import { initSystemProviderKeys } from "../services/model-registry.ts";
import { initRunLimits } from "../services/run-limits.ts";
import { initProxyLimits } from "../services/proxy-limits.ts";
import {
  initSystemPackages,
  getSystemPackages,
  getAllSystemPackageVersions,
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
import { initInlineCompactionWorker } from "../services/inline-compaction.ts";
import { initCancelSubscriber } from "../services/run-tracker.ts";
import { startRunWatchdog } from "../services/run-watchdog.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { ensureBucket } from "@appstrate/db/storage";
import { logInfraMode } from "../infra/index.ts";
import { installPermissionAuditLogger } from "./permission-audit.ts";

export async function boot(): Promise<void> {
  // Register RBAC denial audit handler BEFORE modules load. Every guard
  // created from this point on — core routes via `requirePermission`,
  // module routes via `requireModulePermission`/`requireCorePermission` —
  // flows through the same `permission_denied` log line.
  installPermissionAuditLogger();

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
  // Self-hosting bootstrap side effects (issue #228). Fires only when
  // `createBootstrapOrg` actually inserted the org row. Mirrors the post-
  // create sequence in `routes/organizations.ts` so the bootstrap owner
  // lands on a usable workspace (default app + hello-world agent) AND so
  // module listeners on `onOrgCreate` (cloud free-tier, audit, analytics)
  // observe the org creation. Each side effect catches its own errors —
  // signup must never fail on a non-fatal provisioning hiccup.
  setPostBootstrapOrgHook(triggerPostBootstrapOrg);
  if (env.S3_BUCKET) {
    logger.info("Storage: S3", { bucket: env.S3_BUCKET, endpoint: env.S3_ENDPOINT ?? "AWS" });
  } else {
    logger.info("Storage: filesystem", { path: env.FS_STORAGE_PATH });
  }
  logInfraMode();

  // Warn loudly if TRUST_PROXY is enabled without an obvious reverse
  // proxy in front. `TRUST_PROXY=true|N` tells `lib/client-ip.ts` to
  // honor `X-Forwarded-For` / `X-Real-IP` — which is correct *only*
  // when a trusted proxy is actually terminating the connection and
  // writing those headers. Setting it on a server directly exposed to
  // the internet lets any client spoof its source IP, which in turn
  // bypasses every per-IP rate limit in the platform (notably the
  // OIDC `/oauth2/token` limiter and the CLI device-flow limiters
  // added in ADR-006). We can't detect a real proxy with certainty,
  // but we can flag the most common misconfigurations.
  warnOnTrustProxyMisconfig(env.TRUST_PROXY, env.NODE_ENV);

  // Verify storage backend is accessible (fail-fast if misconfigured)
  await ensureBucket();

  // Parse + validate run limits (PLATFORM_RUN_LIMITS, INLINE_RUN_LIMITS).
  // Throws at boot on invalid shape — no run can start without them.
  initRunLimits();

  // Parse + validate proxy limits (LLM_PROXY_LIMITS, CREDENTIAL_PROXY_LIMITS).
  // Same fail-fast contract as initRunLimits — strict Zod, unknown keys reject.
  initProxyLimits();

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
    initInlineCompactionWorker().catch((err) => {
      logger.warn("Could not initialize inline compaction worker", {
        error: err instanceof Error ? err.message : String(err),
      });
    }),
    startRunWatchdog({
      intervalSeconds: env.RUN_WATCHDOG_INTERVAL_SECONDS,
      stallThresholdSeconds: env.RUN_STALL_THRESHOLD_SECONDS,
      maxFinalizesPerTick: 200,
    }).catch((err) => {
      logger.warn("Could not start run watchdog", {
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

  // Kick off the recurring upload sweep once initial cleanup is scheduled.
  startUploadGc();
}

/**
 * Load system packages from ZIPs on disk, then sync to DB + S3.
 * Upserts packages rows (source: "system"), uploads files to global _system/ namespace,
 * and creates packageVersions with SHA256 SRI integrity.
 */
async function loadAndSyncSystemPackages(): Promise<void> {
  await initSystemPackages();
  const canonicalPackages = getSystemPackages();
  const allVersions = getAllSystemPackageVersions();
  if (canonicalPackages.size === 0) return;

  let syncedPackages = 0;
  let syncedVersions = 0;

  // Step 1 — UPSERT one `packages` row per packageId, using the canonical
  // (highest semver) version. This drives `draftManifest`/`draftContent`,
  // file uploads, and the public package-list UI.
  const syncCanonical = async (id: string, entry: SystemPackageEntry) => {
    const { manifest, type, version } = entry;

    // `updatedAt` is bumped only when this canonical version is genuinely
    // new — re-boots over an unchanged set must remain side-effect-free
    // for downstream consumers that watch `updatedAt`.
    const [existingVersion] = await db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, id), eq(packageVersions.version, version)))
      .limit(1);
    const isNewVersion = !existingVersion;

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

    if (Object.keys(entry.files).length > 1) {
      await uploadPackageFiles(
        storageFolderForType(type),
        SYSTEM_STORAGE_NAMESPACE,
        id,
        entry.files,
      );
    }

    syncedPackages++;
  };

  // Step 2 — register every loaded version in `package_versions` so semver
  // ranges (e.g. `^1.0.0`) keep resolving when a newer major ships
  // alongside the legacy line. createVersionAndUpload is idempotent.
  const syncVersion = async (entry: SystemPackageEntry) => {
    await createVersionAndUpload({
      packageId: entry.packageId,
      version: entry.version,
      createdBy: null,
      zipBuffer: entry.zipBuffer,
      manifest: entry.manifest as unknown as Record<string, unknown>,
    });
    syncedVersions++;
  };

  await Promise.all(
    Array.from(canonicalPackages).map(([id, entry]) =>
      syncCanonical(id, entry).catch((err) => {
        logger.warn("Failed to sync canonical system package", {
          packageId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    ),
  );
  await Promise.all(
    allVersions.map((entry) =>
      syncVersion(entry).catch((err) => {
        logger.warn("Failed to register system package version", {
          packageId: entry.packageId,
          version: entry.version,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    ),
  );

  logger.info("System packages synced", {
    packages: syncedPackages,
    versions: syncedVersions,
  });
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

/**
 * Log a prominent warning when `TRUST_PROXY` is enabled but the operator
 * might not realize what it costs them.
 *
 * `TRUST_PROXY` tells `lib/client-ip.ts` to honor XFF / X-Real-IP. That
 * is ONLY safe when a trusted reverse proxy is terminating the client
 * connection and writing those headers itself — if the server is
 * directly exposed, any client can put arbitrary data in `X-Forwarded-For`
 * and every per-IP rate-limit in the platform collapses. The OIDC
 * `/oauth2/token` limiter, the CLI device-flow limiters, and the
 * per-IP auth limiters all rely on `getClientIpFromRequest` returning
 * the real client address.
 *
 * We can't detect a real proxy with certainty (network topology is
 * out-of-band). The best we can do is flag the two most common
 * misconfigurations: `TRUST_PROXY=true` in production without an
 * obvious reverse-proxy signal, and the default `false` when the
 * server is apparently behind a proxy (XFF present from a first
 * request — out of scope for this boot-time check; runtime detection
 * in a middleware would be more invasive than warranted for v1).
 */
function warnOnTrustProxyMisconfig(trustProxy: string, nodeEnv: string): void {
  if (trustProxy === "false") return;
  const msg =
    `TRUST_PROXY=${trustProxy} — X-Forwarded-For headers will be honored on incoming requests. ` +
    `This is CORRECT only when a trusted reverse proxy (nginx, Traefik, Caddy, cloud LB) ` +
    `is terminating client connections and writing those headers itself. If the server is ` +
    `directly exposed to the internet, any client can spoof their source IP, bypassing every ` +
    `per-IP rate limit (OIDC /oauth2/token, CLI device-flow, auth endpoints). ` +
    `Verify the deployment topology or set TRUST_PROXY=false.`;
  // In production we emit at `error` severity deliberately — a
  // deployment running `LOG_LEVEL=warn` or `error` is exactly the one
  // most likely to silently ship TRUST_PROXY=true with no front proxy,
  // and silencing the warning is the opposite of what the operator
  // needs. The misconfiguration is high-impact (every per-IP rate
  // limit in the platform becomes bypassable) and the line count is
  // one per boot — not spammy. Dev / test are kept at `info` so local
  // runs with TRUST_PROXY=true don't colour the logs red.
  if (nodeEnv === "production") logger.error(msg);
  else logger.info(msg);
}
