// SPDX-License-Identifier: Apache-2.0

import { db, isEmbeddedDb, reservePgConnection, toRows } from "@appstrate/db/client";
import { CURRENT_API_VERSION, listSupportedVersions } from "./api-versions.ts";
import { listOrgsWithUnsupportedApiVersion } from "../services/organizations.ts";
import { expireOldInvitations } from "../services/invitations.ts";
import { cleanupExpiredKeys } from "../services/api-keys.ts";
import { cleanupExpiredUploads, startUploadGc } from "../services/uploads.ts";
import { cleanupExpiredFiles, startFileGc } from "../services/files.ts";
import { startStorageDeletionWorker } from "../services/storage-deletion.ts";
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
import { startRuntimeImageWarmer } from "../services/orchestrator/runtime-image-warmer.ts";
import { getExecutionMode } from "../infra/mode.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { ensureBucket } from "@appstrate/db/storage";
import { logInfraMode } from "../infra/index.ts";
import { installPermissionAuditLogger } from "./permission-audit.ts";
import { mapWithConcurrency } from "./map-with-concurrency.ts";

/**
 * Max concurrent orphan stop+finalize pairs at boot. See the call site — kept
 * well under the postgres.js pool (`max: 20`).
 */
const ORPHAN_CLEANUP_CONCURRENCY = 6;

/**
 * Phase 1 — everything the HTTP surface's *shape* depends on, plus every
 * fail-fast validation. Must finish before the port is bound.
 *
 * Hono throws `Can not add a route since the matcher is already built` the
 * moment a route is registered after the first request has been matched, so
 * module routes (`registerModuleRoutes`) can never be deferred past the bind —
 * which makes module loading, and the core migrations it sits on, strictly
 * pre-bind work. The cheap synchronous validators (`initRunLimits`,
 * `initProxyLimits`, …) stay here too: they exist to abort boot on a bad
 * config, and aborting is only meaningful before anything is listening.
 *
 * Everything that is merely *state the handlers read* moves to
 * {@link bootBackground}, behind the readiness gate in `index.ts`.
 */
export async function bootCritical(): Promise<void> {
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

  // Refuse to boot when the RFC 8707 oauth `resources` columns (migration 0006)
  // are absent although the migrator reported nothing pending. Detection only —
  // the repair is an operator task, see the function's doc comment.
  await assertOAuthResourceColumnsPresent();

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

  // Read the `.afps` archives off disk into the in-memory registry. Cheap
  // (~45 ms) and consulted by request-path helpers (`isSystemPackage`), so it
  // stays pre-bind; the DB + S3 reconciliation it used to be bundled with is
  // the slow half and runs in `bootBackground`.
  await initSystemPackages().catch((err) => {
    logger.warn("Could not load system packages", {
      error: getErrorMessage(err),
    });
  });
}

/**
 * Phase 2 — state, workers and cleanup. Runs AFTER the port is bound, behind
 * the readiness gate in `index.ts`, which answers 503 on every route until
 * this resolves. Nothing here changes the route table.
 *
 * A rejection here is fatal exactly as it was when this code lived in a
 * blocking `await boot()`: the caller in `index.ts` exits the process.
 */
export async function bootBackground(): Promise<{ agentsHealthy: boolean }> {
  const env = (await import("@appstrate/env")).getEnv();

  // Reconcile the loaded system packages into the DB + S3.
  await syncSystemPackagesToDb().catch((err) => {
    logger.warn("Could not sync system packages", {
      error: getErrorMessage(err),
    });
  });

  // Surface orgs whose stored API-version pin this build cannot serve.
  await warnOnUnserveableApiVersionPins().catch((err) => {
    logger.warn("Could not check organization API version pins", {
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
  // `onRunStatusChange` event fires (billing, observability, ...) for runs that
  // burned LLM tokens before the previous process died. The CAS in `finalizeRun`
  // makes this race-safe against a delayed metric POST that lands during
  // the same boot window.
  const orchestrator = getOrchestrator();
  try {
    const orphanIds = await listOrphanRunIds();
    if (orphanIds.length > 0) {
      let finalized = 0;
      // Bounded parallelism, NOT a serial loop. Each orphan costs a Docker
      // `POST /containers/{id}/stop?t=5`, which blocks for up to the full
      // grace period when the container ignores SIGTERM — serially that is
      // 5 s × orphan count added to boot, at exactly the moment (restart
      // after an incident) the API should come back fastest. The grace
      // period itself is deliberately left alone: it is what lets a still
      // running sidecar flush its final events before the SIGKILL.
      //
      // Concurrency is capped well under the postgres.js pool (`max: 20`)
      // because `synthesiseFinalize` writes.
      // The pool aborts on the first rejection (no new orphan is picked up
      // once one worker throws). That is a real change from the pool this used
      // to call, which kept draining the queue regardless — but it cannot fire
      // here: the callback body below catches everything it can raise and
      // degrades to a `logger.warn`, so a boot with N orphans still attempts
      // all N. The abort is the safety net for the day that stops being true.
      await mapWithConcurrency(orphanIds, ORPHAN_CLEANUP_CONCURRENCY, async (runId) => {
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
      });
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
  let agentsHealthy = false;
  const parallelInits: Promise<void>[] = [
    // Billing correctness barrier: unlike ancillary workers, this init is not
    // caught/degraded. Boot must fail if the durable metering recovery channel
    // is unavailable; otherwise a transient ledger write failure after
    // provider spend could be lost permanently.
    initLlmUsageRetryWorker(),
    orchestrator
      .initialize()
      .then(() => {
        agentsHealthy = true;
      })
      .catch((err) => {
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
    // Keep the runtime images warm + pinned on the Docker host. Docker-only:
    // it reconciles Docker images and containers, and every other backend
    // owns its own artifact locality. `initialize()` above pre-pulls once;
    // this is what keeps that true against host-level image pruning between
    // runs (see services/orchestrator/runtime-image-warmer.ts).
    Promise.resolve().then(() => {
      if (getExecutionMode() !== "docker") return;
      startRuntimeImageWarmer({
        intervalSeconds: env.RUNTIME_IMAGE_WARM_INTERVAL_SECONDS,
        images: [
          { image: env.PI_IMAGE, slot: "pi" },
          { image: env.SIDECAR_IMAGE, slot: "sidecar" },
        ],
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
    cleanupExpiredFiles()
      .then((count) => {
        if (count > 0) logger.info("Removed expired files", { count });
      })
      .catch((err) => {
        logger.warn("Could not clean up expired files", {
          error: getErrorMessage(err),
        });
      }),
  ];

  await Promise.all(parallelInits);

  // Kick off the recurring upload + file sweeps once initial cleanup is scheduled.
  startUploadGc();
  startFileGc();
  // Transactional storage-deletion outbox worker: drains any boot-time backlog
  // immediately, then polls for due jobs. Purges S3/FS objects whose DB rows
  // were deleted (files, uploads, run workspaces, org/app/end-user cascades).
  startStorageDeletionWorker();

  return { agentsHealthy };
}

/**
 * Refuse to boot when the RFC 8707 oauth `resources` columns (migration 0006)
 * are absent although the migrator reported nothing pending.
 *
 * drizzle-orm's postgres-js migrator applies migrations by timestamp watermark
 * (`max(created_at)` in `__drizzle_migrations`), NOT by hash-set membership. A
 * production DB whose watermark was corrupted to a future date (known prod
 * incident) reports nothing pending while every migration below that date was
 * never applied — 0006 among them, which adds `resources text[]` to
 * oauth_access_tokens / oauth_consents / oauth_refresh_tokens and re-defaults
 * oauth_clients.level. The pinned better-auth 1.7 oauth-provider then queries
 * columns that do not exist, and token mint fails on resource/MCP flows.
 * Tier 0 cannot reach this state: `applyCorePGliteMigrations` keys on the
 * journal tag, not on a watermark.
 *
 * This used to re-run 0006's DDL here, idempotently, on every boot of every
 * deployment, forever — a broken database made to work silently, with nothing
 * recording when the repair could stop shipping. That is what
 * `docs/NO_TRANSITIONAL_CODE.md` §3 and §5 forbid. The DDL moved to
 * `scripts/migration/0004-oauth-resources-watermark-drift.sql`, run once by an
 * operator; what stays here detects and refuses.
 *
 * NOT retirement machinery, despite replacing a self-heal: it does not refuse a
 * RETIRED FORM, it detects a watermark corruption that — in this function's own
 * words below — "fires for a drift that first appears from here on". The
 * transition it came from is over; the failure mode it guards is not, so
 * `docs/NO_TRANSITIONAL_CODE.md` §4 does not reach it. A transitional-code
 * audit deleted it once on the strength of the resemblance; that was wrong.
 *
 * Refusing rather than warning, deliberately: the drift is not scoped to 0006.
 * It skipped every migration below the corrupted watermark, so a process that
 * kept running would be serving from a schema nobody can enumerate, failing
 * later at arbitrary unrelated queries. One actionable message at boot beats
 * that. The cost is real and accepted — a deployment this used to repair in
 * place now stays down until the script is run.
 *
 * The probe is a signature, not a proof, and the gap is wider than it looks.
 * It sees one migration, so a watermark corrupted *after* 0006 applied leaves
 * these columns present and this check passes with other migrations still
 * missing. Worse for the upgrade path: the self-heal shipped in every release
 * up to this one and ran on every boot, so a database that drifted BEFORE this
 * release already had the columns restored — it will pass here while its
 * watermark is still corrupt. In practice this fires for a drift that first
 * appears from here on, and for restores of a backup taken before the heal.
 *
 * Restoring the columns therefore clears the boot refusal, not the drift.
 * `scripts/migration/0004-…` ships the ledger diagnostic for the real extent,
 * and its header says the same thing.
 *
 * The general check — compare `max(created_at)` in `__drizzle_migrations`
 * against the largest `when` in `meta/_journal.json` — was considered and
 * rejected. It is exact for this incident but refuses boot after any deliberate
 * ROLLBACK, where a database legitimately carries a watermark from a newer
 * release than the code, and turning routine rollbacks into outages costs more
 * than the corruption it would catch. The diagnostic stays a query an operator
 * runs, not a predicate that stops the process.
 *
 * `columnExists` is injected for tests — production reads the live database.
 */
export async function assertOAuthResourceColumnsPresent(
  columnExists: () => Promise<boolean> = oauthResourcesColumnExists,
): Promise<void> {
  if (await columnExists()) return;

  throw new Error(
    "Schema drift: the oauth `resources` columns (migration 0006) are absent even though " +
      "the migrator reported nothing pending. __drizzle_migrations is ahead of the real " +
      "schema, so 0006 — and every other migration below the corrupted watermark — was " +
      "silently skipped. Refusing to boot: token mint would fail at runtime on resource/MCP " +
      "flows, and the rest of the skipped set is unknown. Apply " +
      "scripts/migration/0004-oauth-resources-watermark-drift.sql to this database (it ships " +
      "the diagnostic query for the full extent of the drift), then restart.",
  );
}

async function oauthResourcesColumnExists(): Promise<boolean> {
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
  return present.length > 0;
}

/**
 * Apply Drizzle migrations programmatically for PGlite (embedded mode).
 * Delegates to the shared `applyCorePGliteMigrations` helper so the embedded
 * boot path and the tier0 test preload run identical migration logic.
 */
async function applyEmbeddedMigrations(): Promise<void> {
  const { resolve } = await import("node:path");
  const { applyCorePGliteMigrations } = await import("./pglite-migrate.ts");
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

/**
 * Boot-time audit of stored org API-version pins.
 *
 * `middleware/api-version.ts` 400s on a pin this build cannot serve, and it is
 * mounted on `*` — so an org holding an unserveable value fails EVERY org-scoped
 * route, with the only trace being that org's own 400s. Nothing else notices:
 * the platform boots clean, health checks pass, other tenants are unaffected.
 *
 * Two things can put such a value in the table, and neither is visible in the
 * code alone. A version dropped from `SUPPORTED_VERSIONS` without the backfill
 * its docblock mandates; or a historical `PUT /api/orgs/:orgId/settings` from
 * before that route validated `api_version` (it took a bare `z.string()`, and
 * the field is declared writable in the OpenAPI spec, so a hand-rolled client
 * could persist anything). This check covers both.
 *
 * Deliberately a LOG, not a migration and not a fail-fast:
 *   - A migration would repoint the rows, which is a silent write to tenant
 *     configuration on a hypothesis. It would also fix today's rows once and
 *     leave the next dropped version unguarded; this fires on every boot.
 *   - Aborting boot would convert one tenant's misconfiguration into a
 *     platform-wide outage — strictly worse than the fault it reports.
 *
 * Emitted at `error` for the same reason as `warnOnTrustProxyMisconfig`: the
 * deployment most likely to hit this is the one running `LOG_LEVEL=error`, and
 * the remedy (one `PUT` per named org) is only actionable if the ids are in the
 * line. Silent on a healthy instance — zero rows, zero output.
 */
async function warnOnUnserveableApiVersionPins(): Promise<void> {
  const supported = listSupportedVersions();
  const offenders = await listOrgsWithUnsupportedApiVersion(supported);
  if (offenders.length === 0) return;

  logger.error(
    `${offenders.length} organization(s) are pinned to an API version this build cannot serve. ` +
      `Every org-scoped route will answer 400 unsupported_api_version for them until the pin is ` +
      `repaired (PUT /api/orgs/:orgId/settings with a supported api_version).`,
    {
      supportedVersions: supported,
      currentVersion: CURRENT_API_VERSION,
      orgs: offenders.map((o) => ({ orgId: o.id, pinnedVersion: o.apiVersion })),
    },
  );
}

/**
 * Boot-time reachability probe for `USERCONTENT_URL` (issue #1001).
 *
 * The platform *signs* preview URLs (`services/files.ts` → `mintPreviewUrl`)
 * but never fetches them — so if `USERCONTENT_URL` is set to a host the browser
 * cannot reach, every `preview_url` this instance mints is dead with zero
 * server-side trace. This probe fires ONE unauthenticated GET at the preview
 * route on that origin and, unless it gets the expected `401` (route exists and
 * enforces the preview token — the healthy case), emits a single `error`-level
 * line naming the URL and observed status.
 *
 * Never fatal, never awaited, never blocks readiness: it is kicked off
 * fire-and-forget from `index.ts` AFTER `markServerReady()` so it can't race the
 * boot gate (which 503s every route until ready — a mid-boot probe against a
 * hairpin route would see that 503 instead of the real 401 and false-positive on
 * every boot). Only runs when `USERCONTENT_URL` is defined.
 */
export async function probeUsercontentReachability(): Promise<void> {
  const env = (await import("@appstrate/env")).getEnv();
  if (!env.USERCONTENT_URL) return; // only meaningful when the origin is configured
  // Replicate `mintPreviewUrl`'s slash-trim so we probe the exact base we sign.
  let base = env.USERCONTENT_URL;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const url = `${base}/preview/files/_probe`;
  const status: number | null = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(3000),
  })
    .then((res) => res.status)
    // Timeout / connection refused / DNS failure — treated as "not 401".
    .catch(() => null);
  if (status === 401) return; // route reached AND enforcing auth → healthy, stay silent
  logger.error(
    `USERCONTENT_URL preview probe did not return 401 (got ${status ?? "no response"}). ` +
      `Every preview_url this instance signs points at ${base} — if that host is unrouted, all ` +
      `file previews are dead with no server-side trace. NOTE: this probe reaches the host from ` +
      `INSIDE the container network; a failure here can be a false positive when hairpin-NAT / ` +
      `split-horizon DNS prevents the container from reaching its own public hostname while browsers ` +
      `reach it fine. Verify a preview actually fails before acting.`,
    { url, status },
  );
}
