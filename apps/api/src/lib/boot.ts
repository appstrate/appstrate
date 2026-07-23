// SPDX-License-Identifier: Apache-2.0

import { db, isEmbeddedDb, reservePgConnection, toRows } from "@appstrate/db/client";
import { expireOldInvitations } from "../services/invitations.ts";
import { cleanupExpiredKeys } from "../services/api-keys.ts";
import { cleanupExpiredUploads, startUploadGc } from "../services/uploads.ts";
import { cleanupExpiredDocuments, startDocumentGc } from "../services/documents.ts";
import { createNotifyTriggers } from "@appstrate/db/notify";
import { logger } from "./logger.ts";
import {
  loadModules,
  getModules,
  getModuleContributions,
  getModuleModelProviders,
  callAllHooks,
} from "./modules/module-loader.ts";
import { getModuleRegistry, buildModuleInitContext } from "./modules/registry.ts";
import { registerEmailOverrides } from "@appstrate/emails";
import {
  setBeforeSignupHook,
  setAfterSignupHook,
  setPostBootstrapOrgHook,
  createAuth,
  type BetterAuthPluginList,
} from "@appstrate/db/auth";
import { getErrorMessage } from "@appstrate/core/errors";
import { triggerPostBootstrapOrg } from "./post-bootstrap-hook.ts";
import { reconcileBootstrapTokenAtBoot } from "./bootstrap-token.ts";
import { initRealtime } from "../services/realtime.ts";
import { initSystemProxies } from "../services/proxy-registry.ts";
import { initSystemModelProviderKeys } from "../services/model-registry.ts";
import { initSystemIntegrations } from "../services/integration-client-registry.ts";
import { registerModelProviders } from "../services/model-providers/registry.ts";
import { initRunLimits } from "../services/run-limits.ts";
import { initProxyLimits } from "../services/proxy-limits.ts";
import { initSystemPackages, syncSystemPackagesToDb } from "../services/system-packages.ts";
import { listOrphanRunIds } from "../services/state/runs.ts";
import { synthesiseFinalize } from "../services/run-event-ingestion.ts";
import { initScheduleWorker } from "../services/scheduler.ts";
import { initInlineCompactionWorker } from "../services/inline-compaction.ts";
import { initOAuthModelRefreshWorker } from "../services/model-providers/refresh-worker.ts";
import { initPairingCleanupWorker } from "../services/model-providers/pairing-cleanup-worker.ts";
import { initLlmUsageRetryWorker } from "../services/llm-usage-retry.ts";
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

  // Self-heal RFC 8707 oauth `resources` columns (migration 0006) when the
  // migration watermark is ahead of the real schema. Idempotent — a no-op on
  // any healthy DB, runs the missing DDL only on a watermark-drifted prod DB.
  await reconcileOAuthResourceColumns().catch((err) => {
    logger.warn("Could not reconcile oauth resource columns", {
      error: getErrorMessage(err),
    });
  });

  // Bootstrap-token reconciliation (#344). If the env still carries an
  // AUTH_BOOTSTRAP_TOKEN but at least one org exists, the token is dead —
  // flip the in-memory consumed flag so the per-request `bootstrapTokenPending`
  // boolean in AppConfig reports `false` immediately. Otherwise an operator
  // who forgot to clear .env after a successful claim sends returning
  // visitors back through `/claim`, where redemption then 410s.
  await reconcileBootstrapTokenAtBoot().catch((err) => {
    logger.warn("Could not reconcile bootstrap token at boot", {
      error: getErrorMessage(err),
    });
  });

  // Load modules (cloud, webhooks, etc.)
  // Modules may run their own migrations in init() — core DB is ready.
  await loadModules(getModuleRegistry(), buildModuleInitContext());

  // Aggregate model provider contributions from every loaded module into
  // the runtime registry. The three core API-key providers (openai,
  // anthropic, openai-compatible) ship as the `core-providers` module;
  // OAuth-flavoured providers ship as opt-in workspace modules
  // (`@appstrate/module-*`). There is no in-code seed.
  registerModelProviders(getModuleModelProviders());

  // Initialize Better Auth AFTER modules have registered their plugin +
  // schema contributions. `createAuth()` narrows the `unknown[]` from the
  // core contract to Better Auth's plugin list type. Module tables (e.g.
  // OIDC's oauth_clients/jwks) now live in the core schema barrel, so the
  // Better Auth adapter resolves them directly — no module schema injection.
  const contributions = getModuleContributions();
  createAuth(contributions.betterAuthPlugins as BetterAuthPluginList);

  // Wire module contributions that were declared on the module contract
  for (const mod of getModules().values()) {
    if (mod.emailOverrides) {
      registerEmailOverrides(mod.emailOverrides);
    }
  }
  // `beforeSignup` / `afterSignup` broadcast to EVERY loaded module (not
  // first-match-wins like the other hooks) via `callAllHooks`: the cloud
  // free-tier gate AND the OIDC per-client signup policy both run on every
  // signup, and a throwing `beforeSignup` aborts user creation. OIDC's
  // `afterSignup` auto-joins the new user to the org pinned by the in-flight
  // OAuth client so the onward /authorize redirect completes.
  setBeforeSignupHook((email, ctx) => callAllHooks("beforeSignup", email, ctx));
  setAfterSignupHook((user, ctx) => callAllHooks("afterSignup", user, ctx));
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
  // added recently). We can't detect a real proxy with certainty,
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
  initSystemModelProviderKeys();
  logger.info("System provider keys loaded");

  // Load system integrations (auto-active policy + shared OAuth clients) from
  // the SYSTEM_INTEGRATIONS env var
  initSystemIntegrations();

  // Load system packages from ZIPs, sync to DB + S3
  await loadAndSyncSystemPackages().catch((err) => {
    logger.warn("Could not load/sync system packages", {
      error: getErrorMessage(err),
    });
  });

  // Parallel init: NOTIFY triggers and realtime are independent
  await Promise.all([
    createNotifyTriggers(db)
      .then(() => logger.info("NOTIFY triggers installed"))
      .catch((err) => {
        logger.warn("Could not install NOTIFY triggers", {
          error: getErrorMessage(err),
        });
      }),
    initRealtime().catch((err) => {
      logger.warn("Could not initialize realtime LISTEN", {
        error: getErrorMessage(err),
      });
    }),
  ]);

  // Sequential cleanup: orphan runs must be finalized before container
  // cleanup, and containers must be cleaned before orchestrator init.
  //
  // Each orphan flows through `synthesiseFinalize` → `finalizeRun` so the
  // afterRun hook fires (billing, observability, ...) for runs that burned
  // LLM tokens before the previous process died. The CAS in `finalizeRun`
  // makes this race-safe against a delayed metric POST that lands during
  // the same boot window.
  const orchestrator = getOrchestrator();
  try {
    const orphanIds = await listOrphanRunIds();
    if (orphanIds.length > 0) {
      let finalized = 0;
      for (const runId of orphanIds) {
        try {
          // An orphaned run may still have a live remote workload — a
          // firecracker microVM on the runner host keeps executing (and
          // billing) across a platform restart, and holds a concurrency
          // slot. Stop it before synthesising the failed terminal. This
          // is safe for every adapter: docker stops idempotently, process
          // finds nothing after a restart, firecracker proxies the stop
          // to the daemon which kills the microVM. `listOrphanRunIds`
          // already excludes runs a live sibling instance heartbeats
          // (stall-threshold cutoff), so this never kills another
          // instance's in-flight run.
          await orchestrator.stopByRunId(runId).catch((err) => {
            logger.warn("Could not stop orphaned run's workload", {
              runId,
              error: getErrorMessage(err),
            });
          });
          await synthesiseFinalize(runId, {
            status: "failed",
            error: { message: "Server restarted while run was in progress. Please retry." },
          });
          finalized++;
        } catch (err) {
          logger.warn("Could not finalize orphaned run", {
            runId,
            error: getErrorMessage(err),
          });
        }
      }
      logger.info("Finalized orphaned runs", { count: finalized, runIds: orphanIds });
    }
  } catch (err) {
    logger.warn("Could not clean orphaned runs", {
      error: getErrorMessage(err),
    });
  }

  try {
    const report = await orchestrator.cleanupOrphans();
    if (report.workloads > 0 || report.isolationBoundaries > 0) {
      logger.info("Cleaned up orphaned resources", { ...report });
    }
  } catch (err) {
    logger.warn("Could not clean up orphaned resources", {
      error: getErrorMessage(err),
    });
  }

  // Initialize cross-instance cancel subscriber
  await initCancelSubscriber();

  // Parallel init: orchestrator, scheduler, and DB cleanups are all independent
  const parallelInits: Promise<void>[] = [
    // Billing correctness barrier: unlike ancillary workers, this init is not
    // caught/degraded. Boot must fail if the durable metering recovery channel
    // is unavailable; otherwise a transient ledger write failure after
    // provider spend could be lost permanently.
    initLlmUsageRetryWorker(),
    orchestrator.initialize().catch((err) => {
      logger.warn("Could not initialize container orchestrator", {
        error: getErrorMessage(err),
      });
    }),
    initScheduleWorker().catch((err) => {
      logger.warn("Could not initialize schedule worker", {
        error: getErrorMessage(err),
      });
    }),
    initInlineCompactionWorker().catch((err) => {
      logger.warn("Could not initialize inline compaction worker", {
        error: getErrorMessage(err),
      });
    }),
    // OAuth refresh worker is opt-in (OAUTH_REFRESH_WORKER_ENABLED). The
    // sidecar's reactive 401-retry path and the on-demand token resolver
    // cover correctness without it; the worker only matters for credentials
    // that go dormant long enough that their refresh_token would expire
    // upstream.
    (env.OAUTH_REFRESH_WORKER_ENABLED ? initOAuthModelRefreshWorker() : Promise.resolve()).catch(
      (err) => {
        logger.warn("Could not initialize OAuth model refresh worker", {
          error: getErrorMessage(err),
        });
      },
    ),
    // Pairing-table cleanup runs unconditionally — pure table-bloat
    // janitor for `model_provider_pairings`, unrelated to the refresh
    // hot path.
    initPairingCleanupWorker().catch((err) => {
      logger.warn("Could not initialize OAuth model pairing cleanup worker", {
        error: getErrorMessage(err),
      });
    }),
    startRunWatchdog({
      intervalSeconds: env.RUN_WATCHDOG_INTERVAL_SECONDS,
      stallThresholdSeconds: env.RUN_STALL_THRESHOLD_SECONDS,
      maxFinalizesPerTick: 200,
    }).catch((err) => {
      logger.warn("Could not start run watchdog", {
        error: getErrorMessage(err),
      });
    }),
    expireOldInvitations()
      .then((expiredCount) => {
        if (expiredCount > 0) logger.info("Expired old invitations", { count: expiredCount });
      })
      .catch((err) => {
        logger.warn("Could not expire old invitations", {
          error: getErrorMessage(err),
        });
      }),
    cleanupExpiredKeys()
      .then((expiredKeyCount) => {
        if (expiredKeyCount > 0)
          logger.info("Revoked expired API keys", { count: expiredKeyCount });
      })
      .catch((err) => {
        logger.warn("Could not clean up expired API keys", {
          error: getErrorMessage(err),
        });
      }),
    cleanupExpiredUploads()
      .then((count) => {
        if (count > 0) logger.info("Removed expired unconsumed uploads", { count });
      })
      .catch((err) => {
        logger.warn("Could not clean up expired uploads", {
          error: getErrorMessage(err),
        });
      }),
    cleanupExpiredDocuments()
      .then((count) => {
        if (count > 0) logger.info("Removed expired documents", { count });
      })
      .catch((err) => {
        logger.warn("Could not clean up expired documents", {
          error: getErrorMessage(err),
        });
      }),
  ];

  await Promise.all(parallelInits);

  // Kick off the recurring upload + document sweeps once initial cleanup is scheduled.
  startUploadGc();
  startDocumentGc();
}

/**
 * Load system packages from ZIPs on disk, then sync to DB + S3.
 * Upserts packages rows (source: "system"), uploads files to global _system/ namespace,
 * and creates packageVersions with SHA256 SRI integrity.
 */
async function loadAndSyncSystemPackages(): Promise<void> {
  await initSystemPackages();
  await syncSystemPackagesToDb();
}

/**
 * Self-heal the RFC 8707 oauth `resources` columns when the migration
 * watermark is ahead of the actual schema.
 *
 * Migration 0006 adds `resources text[]` to oauth_access_tokens /
 * oauth_consents / oauth_refresh_tokens (audience binding) and re-defaults
 * oauth_clients.level. drizzle-orm's postgres-js migrator applies migrations
 * by timestamp watermark (`max(created_at)` in `__drizzle_migrations`), NOT by
 * hash-set membership: a production DB whose watermark was corrupted to a
 * future date (known prod incident) silently SKIPS 0006. The pinned
 * better-auth 1.7 oauth-provider then expects columns that were never created,
 * which breaks token mint on resource/MCP flows.
 *
 * This runs the same additive DDL as 0006 — idempotently (`IF NOT EXISTS`) —
 * AFTER the migrator. On a healthy DB the columns already exist and it is a
 * no-op. On a watermark-drifted DB it creates the missing columns and logs
 * loudly so the operator realigns `__drizzle_migrations` before the *next*
 * schema release (this guard only covers 0006).
 */
async function reconcileOAuthResourceColumns(): Promise<void> {
  const { sql: rawSql } = await import("drizzle-orm");
  const present = toRows(
    await db.execute(rawSql`
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'oauth_access_tokens'
        AND column_name = 'resources'
      LIMIT 1
    `),
  );
  if (present.length > 0) return;

  logger.error(
    "Schema drift: oauth `resources` columns (migration 0006) are absent even though " +
      "the migration watermark is satisfied. The __drizzle_migrations watermark is ahead " +
      "of the real schema, so 0006 was silently skipped. Self-healing the columns now — " +
      "realign __drizzle_migrations so future migrations are not skipped too.",
  );
  await db.execute(
    rawSql`ALTER TABLE "oauth_access_tokens" ADD COLUMN IF NOT EXISTS "resources" text[]`,
  );
  await db.execute(
    rawSql`ALTER TABLE "oauth_consents" ADD COLUMN IF NOT EXISTS "resources" text[]`,
  );
  await db.execute(
    rawSql`ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "resources" text[]`,
  );
  await db.execute(rawSql`ALTER TABLE "oauth_clients" ALTER COLUMN "level" SET DEFAULT 'instance'`);
  logger.warn("Self-healed oauth `resources` columns (migration 0006 watermark drift)");
}

/**
 * Apply Drizzle migrations programmatically for PGlite (embedded mode).
 * Delegates to the shared `applyCorePGliteMigrations` helper so the embedded
 * boot path and the tier0 test preload run identical migration logic.
 */
async function applyEmbeddedMigrations(): Promise<void> {
  const { resolve } = await import("node:path");
  const { applyCorePGliteMigrations } = await import("./modules/migrate.ts");
  await applyCorePGliteMigrations(resolve(import.meta.dir, "../../../../packages/db/drizzle"));
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
