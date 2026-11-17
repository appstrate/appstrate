// SPDX-License-Identifier: Apache-2.0

import { db, isEmbeddedDb } from "@appstrate/db/client";
import {
  applyCoreMigrations,
  assertCoreMigrationsApplied,
  CORE_MIGRATIONS_FOLDER,
} from "@appstrate/db/core-migrations";
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
  getModuleRegistry,
  loadModules,
  getModules,
  getModuleContributions,
  getModuleModelProviders,
  callAllHooks,
} from "./modules/module-loader.ts";
import { buildModuleInitContext } from "./modules/registry.ts";
import { registerEmailOverrides } from "@appstrate/emails";
import {
  setBeforeSignupHook,
  setAfterSignupHook,
  setPostBootstrapOrgHook,
  createAuth,
  type BetterAuthPluginList,
} from "@appstrate/db/auth";
import { getErrorMessage } from "@appstrate/core/errors";
import { betterAuthRateLimitStorage } from "../infra/rate-limit/better-auth-storage.ts";
import { CLIENT_IP_HEADER } from "./client-ip.ts";
import { triggerPostBootstrapOrg } from "./post-bootstrap-hook.ts";
import { reconcileBootstrapTokenAtBoot } from "./bootstrap-token.ts";
import { initRealtime } from "../services/realtime.ts";
import { retryUntilSuccess } from "./retry-until-success.ts";
import { initCacheBus } from "./cache-bus.ts";
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
import { initPersonalSpaceSweeperWorker } from "../services/personal-space-sweeper.ts";
import { initOAuthModelRefreshWorker } from "../services/model-providers/refresh-worker.ts";
import { initPairingCleanupWorker } from "../services/model-providers/pairing-cleanup-worker.ts";
import { startModelCatalogSync } from "../services/model-catalog-sync.ts";
import { initLlmUsageRetryWorker } from "../services/llm-usage-retry.ts";
import { initCancelSubscriber } from "../services/run-tracker.ts";
import { startRunWatchdog } from "../services/run-watchdog.ts";
import { startRuntimeImageWarmer } from "../services/orchestrator/runtime-image-warmer.ts";
import { getExecutionMode } from "../infra/mode.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import {
  initializeAgentRuntime,
  markRunCapacityReady,
} from "../services/orchestrator/agent-runtime-readiness.ts";
import { ensureBucket } from "@appstrate/db/storage";
import { logInfraMode } from "../infra/index.ts";
import { initBundleSignaturePolicy } from "../services/run-launcher/bundle-signature-policy.ts";
import { installPermissionAuditLogger } from "./permission-audit.ts";
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { warnOnUnreadEnvKeys } from "./unread-env-keys.ts";
import { bootStep } from "./boot-step.ts";
import {
  assertKeyringCoversCiphertexts,
  assertOAuthResourceColumnsPresent,
} from "./boot-guards/schema-invariants.ts";
import { assertNoPendingDataScripts } from "./boot-guards/pending-data-scripts.ts";

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
 * {@link bootServing} / {@link bootRunCapacity} / {@link bootHousekeeping}, behind the
 * boot gate in `index.ts` (serving) and the run-capacity check in the services.
 */
export async function bootCritical(): Promise<void> {
  // First, so the unread-key line is logged even if a later boot step fails.
  // Namespace rule and limits: docs/ENV.md § Unread keys (docs/NO_TRANSITIONAL_CODE.md §4).
  await bootStep("critical", "warn-unread-env-keys", () => warnOnUnreadEnvKeys());

  // Register RBAC denial audit handler BEFORE modules load. Every guard
  // created from this point on — core routes via `requirePermission`,
  // module routes via `requireModulePermission`/`requireCorePermission` —
  // flows through the same `permission_denied` log line.
  await bootStep("critical", "permission-audit-logger", () => installPermissionAuditLogger());

  // Apply core migrations at boot (before modules, so DB is ready).
  // Both PGlite and PostgreSQL migrate at boot, except PostgreSQL under
  // MIGRATIONS_ON_BOOT=verify (see below); no manual `db:migrate` step needed.
  const env = (await import("@appstrate/env")).getEnv();
  await bootStep("critical", "core-migrations", async () => {
    if (isEmbeddedDb) {
      logger.info("Database: PGlite (embedded)", { path: env.PGLITE_DATA_DIR });
      await applyEmbeddedMigrations();
    } else {
      logger.info("Database: PostgreSQL", {
        url: env.DATABASE_URL?.replace(/\/\/.*@/, "//***@") ?? "",
        migrationsOnBoot: env.MIGRATIONS_ON_BOOT,
      });
      // `verify`: a separate step (the compose `appstrate-migrate` service) owns the
      // migrations, so boot applies no core migration and refuses a database behind its code.
      if (env.MIGRATIONS_ON_BOOT === "verify") {
        await assertCoreMigrationsApplied(env.DATABASE_URL!);
      } else {
        await applyCoreMigrations(env.DATABASE_URL!);
        logger.info("Core migrations applied");
      }
    }
  });

  await bootStep("critical", "assert-oauth-resource-columns", () =>
    assertOAuthResourceColumnsPresent(),
  );

  const embeddedDataDir = isEmbeddedDb
    ? (await import("node:path")).resolve(env.PGLITE_DATA_DIR)
    : null;
  await bootStep("critical", "pending-data-scripts", () =>
    assertNoPendingDataScripts(embeddedDataDir),
  );

  await bootStep("critical", "assert-keyring-covers-ciphertexts", () =>
    assertKeyringCoversCiphertexts(),
  );

  // Bootstrap-token reconciliation. If the env still carries an
  // AUTH_BOOTSTRAP_TOKEN but at least one org exists, the token is dead —
  // flip the in-memory consumed flag so the per-request `bootstrapTokenPending`
  // boolean in AppConfig reports `false` immediately. Otherwise an operator
  // who forgot to clear .env after a successful claim sends returning
  // visitors back through `/claim`, where redemption then 410s.
  await bootStep("critical", "reconcile-bootstrap-token", () =>
    reconcileBootstrapTokenAtBoot().catch((err) => {
      logger.warn("Could not reconcile bootstrap token at boot", {
        error: getErrorMessage(err),
      });
    }),
  );

  // Load modules (oidc, webhooks, etc.)
  // Modules may run their own migrations in init() — core DB is ready.
  await bootStep("critical", "load-modules", () =>
    loadModules(getModuleRegistry(), buildModuleInitContext()),
  );

  // Aggregate model provider contributions from every loaded module into
  // the runtime registry. The three core API-key providers (openai,
  // anthropic, openai-compatible) ship as the `core-providers` module;
  // OAuth-flavoured providers ship as opt-in workspace modules
  // (`@appstrate/module-*`). There is no in-code seed.
  await bootStep("critical", "register-model-providers", () =>
    registerModelProviders(getModuleModelProviders()),
  );

  // Initialize Better Auth AFTER modules have registered their plugin +
  // schema contributions. Passed as a thunk, which `createAuth()` calls
  // exactly once here — it re-collects (rather than re-using plugin objects a
  // previous build already initialized) whenever the instance is rebuilt. The
  // cast narrows the `unknown[]` from the core contract to Better Auth's
  // plugin list type. Module tables (e.g. OIDC's oauth_clients/jwks) now live
  // in the core schema barrel, so the Better Auth adapter resolves them
  // directly — no module schema injection.
  await bootStep("critical", "create-auth", () =>
    createAuth({
      plugins: () => getModuleContributions().betterAuthPlugins as BetterAuthPluginList,
      rateLimitStorage: betterAuthRateLimitStorage(),
      rateLimitEnabled: env.NODE_ENV === "production",
      clientIpHeader: CLIENT_IP_HEADER,
    }),
  );

  // Wire module contributions that were declared on the module contract
  await bootStep("critical", "wire-module-contributions", () => {
    for (const mod of getModules().values()) {
      if (mod.emailOverrides) {
        registerEmailOverrides(mod.emailOverrides);
      }
    }
  });
  // `beforeSignup` / `afterSignup` broadcast to EVERY loaded module (not
  // first-match-wins like the other hooks) via `callAllHooks`: the ee module's
  // free-tier gate AND the OIDC per-client signup policy both run on every
  // signup, and a throwing `beforeSignup` aborts user creation. OIDC's
  // `afterSignup` auto-joins the new user to the org pinned by the in-flight
  // OAuth client so the onward /authorize redirect completes.
  setBeforeSignupHook((email, ctx) => callAllHooks("beforeSignup", email, ctx));
  setAfterSignupHook((user, ctx) => callAllHooks("afterSignup", user, ctx));
  // Self-hosting bootstrap side effects. Fires only when
  // `createBootstrapOrg` actually inserted the org row. Mirrors the post-
  // create sequence in `routes/organizations.ts` so the bootstrap owner
  // lands on a usable workspace (default app + hello-world agent) AND so
  // module listeners on `onOrgCreate` (the ee module's free-tier gate, audit,
  // analytics) observe the org creation. Each side effect catches its own errors —
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
  await bootStep("critical", "ensure-bucket", () => ensureBucket());

  // Parse AFPS_TRUST_ROOT (fail-fast) and log the effective signature policy.
  await bootStep("critical", "init-bundle-signature-policy", () => initBundleSignaturePolicy());

  // Parse + validate run limits (PLATFORM_RUN_LIMITS, INLINE_RUN_LIMITS).
  // Throws at boot on invalid shape — no run can start without them.
  await bootStep("critical", "init-run-limits", () => initRunLimits());

  // Parse + validate proxy limits (LLM_PROXY_LIMITS, CREDENTIAL_PROXY_LIMITS).
  // Same fail-fast contract as initRunLimits — strict Zod, unknown keys reject.
  await bootStep("critical", "init-proxy-limits", () => initProxyLimits());

  // Load system proxies from SYSTEM_PROXIES env var
  await bootStep("critical", "init-system-proxies", () => initSystemProxies());
  logger.info("System proxies loaded");

  // Load system provider keys + models from SYSTEM_PROVIDER_KEYS env var
  await bootStep("critical", "init-system-model-provider-keys", () =>
    initSystemModelProviderKeys(),
  );
  logger.info("System provider keys loaded");

  // Load system integrations (auto-active policy + shared OAuth clients) from
  // the SYSTEM_INTEGRATIONS env var
  await bootStep("critical", "init-system-integrations", () => initSystemIntegrations());

  // Read the `.afps` archives off disk into the in-memory registry. Cheap
  // and consulted by request-path helpers (`isSystemPackage`), so it
  // stays pre-bind; the DB + S3 reconciliation is the slow half and runs in
  // `bootServing`.
  await bootStep("critical", "init-system-packages", () =>
    initSystemPackages().catch((err) => {
      logger.warn("Could not load system packages", {
        error: getErrorMessage(err),
      });
    }),
  );
}

/**
 * Phase 2a — serving. Runs AFTER the port is bound, behind the readiness gate in
 * `index.ts`, which answers 503 on every route until this resolves; reads, auth
 * and the dashboard need nothing more. Nothing here changes the route table.
 *
 * A rejection is fatal: the caller in `index.ts` exits the process.
 */
export async function bootServing(): Promise<void> {
  // Reconcile the loaded system packages into the DB + S3.
  await bootStep("serving", "sync-system-packages", () =>
    syncSystemPackagesToDb().catch((err) => {
      logger.warn("Could not sync system packages", {
        error: getErrorMessage(err),
      });
    }),
  );

  // Surface orgs whose stored API-version pin this build cannot serve.
  await bootStep("serving", "api-version-pins", () =>
    warnOnUnserveableApiVersionPins().catch((err) => {
      logger.warn("Could not check organization API version pins", {
        error: getErrorMessage(err),
      });
    }),
  );

  // Read in the background: boot never waits on the channel.
  await bootStep("serving", "model-catalog-sync", () => startModelCatalogSync());

  // Parallel init: NOTIFY triggers and realtime are independent
  await Promise.all([
    // `error`, not `warn`: without the triggers every dashboard SSE is silent
    // for the life of the process, and without LISTEN until a retry succeeds.
    bootStep("serving", "notify-triggers", () =>
      createNotifyTriggers(db)
        .then(() => logger.info("NOTIFY triggers installed"))
        .catch((err) => {
          logger.error("Could not install NOTIFY triggers", {
            error: getErrorMessage(err),
          });
        }),
    ),
    bootStep("serving", "realtime-listen", () =>
      retryUntilSuccess("Realtime LISTEN", () => initRealtime(), {
        initialDelayMs: 1_000,
        level: "error",
      }),
    ),
    // Cross-replica cache invalidation rides the same LISTEN client. Without
    // it every `@appstrate/core/cache` invalidation stays process-local and
    // other replicas fall back to their TTL — degraded, not broken.
    bootStep("serving", "cache-bus", () =>
      initCacheBus().catch((err) => {
        logger.warn("Could not initialize the cache invalidation bus", {
          error: getErrorMessage(err),
        });
      }),
    ),
  ]);

  // Initialize cross-instance cancel subscriber
  await bootStep("serving", "cancel-subscriber", () => initCancelSubscriber());

  // Billing correctness barrier: unlike ancillary workers, this init is not
  // caught/degraded. Boot must fail if the durable metering recovery channel
  // is unavailable; otherwise a transient ledger write failure after
  // provider spend could be lost permanently.
  await bootStep("serving", "llm-usage-retry-worker", () => initLlmUsageRetryWorker());
}

/**
 * Phase 2b — run capacity. Orphan cleanup then the runtime's first
 * `initialize()` attempt (image pre-pull); only execution needs them. When they
 * are done {@link markRunCapacityReady} lifts the launch refusal
 * (`assertRunCapacityReady`) and the run-related workers start. A rejection is
 * fatal, as for {@link bootServing}.
 */
export async function bootRunCapacity(): Promise<void> {
  const startedAt = performance.now();
  const env = (await import("@appstrate/env")).getEnv();
  // Sequential cleanup: orphan runs must be finalized before container
  // cleanup, and containers must be cleaned before orchestrator init.
  //
  // Each orphan flows through `synthesiseFinalize` → `finalizeRun` so the
  // `onRunStatusChange` event fires (billing, observability, ...) for runs that
  // burned LLM tokens before the previous process died. The CAS in `finalizeRun`
  // makes this race-safe against a delayed metric POST that lands during
  // the same boot window.
  const orchestrator = getOrchestrator();
  await bootStep("run-capacity", "orphan-runs", async () => {
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
        // once one worker throws). It cannot fire here: the callback body below
        // catches everything it can raise and degrades to a `logger.warn`, so a
        // boot with N orphans still attempts all N.
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
  });

  await bootStep("run-capacity", "orphan-resources", async () => {
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
  });

  await bootStep("run-capacity", "agent-runtime", () => initializeAgentRuntime(orchestrator));
  markRunCapacityReady();
  logger.info("Run capacity ready", { runCapacityMs: Math.round(performance.now() - startedAt) });

  await Promise.all([
    bootStep("run-capacity", "schedule-worker", () =>
      initScheduleWorker().catch((err) => {
        logger.warn("Could not initialize schedule worker", {
          error: getErrorMessage(err),
        });
      }),
    ),
    bootStep("run-capacity", "inline-compaction-worker", () =>
      initInlineCompactionWorker().catch((err) => {
        logger.warn("Could not initialize inline compaction worker", {
          error: getErrorMessage(err),
        });
      }),
    ),
    bootStep("run-capacity", "run-watchdog", () =>
      startRunWatchdog({
        intervalSeconds: env.RUN_WATCHDOG_INTERVAL_SECONDS,
        stallThresholdSeconds: env.RUN_STALL_THRESHOLD_SECONDS,
        maxFinalizesPerTick: 200,
      }).catch((err) => {
        logger.warn("Could not start run watchdog", {
          error: getErrorMessage(err),
        });
      }),
    ),
    // Keep the runtime images warm + pinned on the Docker host. Docker-only:
    // it reconciles Docker images and containers, and every other backend
    // owns its own artifact locality. `initialize()` above pre-pulls once;
    // this is what keeps that true against host-level image pruning between
    // runs (see services/orchestrator/runtime-image-warmer.ts).
    bootStep("run-capacity", "runtime-image-warmer", () => {
      if (getExecutionMode() !== "docker") return;
      startRuntimeImageWarmer({
        intervalSeconds: env.RUNTIME_IMAGE_WARM_INTERVAL_SECONDS,
        images: [
          { image: env.PI_IMAGE, slot: "pi" },
          { image: env.SIDECAR_IMAGE, slot: "sidecar" },
        ],
      });
    }),
  ]);
}

/**
 * Phase 2c — housekeeping. Table-bloat janitors and storage GC; nothing waits
 * on them. A rejection is fatal, as for {@link bootServing}.
 */
export async function bootHousekeeping(): Promise<void> {
  const env = (await import("@appstrate/env")).getEnv();
  await Promise.all([
    bootStep("housekeeping", "personal-space-sweeper-worker", () =>
      initPersonalSpaceSweeperWorker().catch((err) => {
        logger.warn("Could not initialize personal-space sweeper", {
          error: getErrorMessage(err),
        });
      }),
    ),
    // OAuth refresh worker is opt-in (OAUTH_REFRESH_WORKER_ENABLED). The
    // sidecar's reactive 401-retry path and the on-demand token resolver
    // cover correctness without it; the worker only matters for credentials
    // that go dormant long enough that their refresh_token would expire
    // upstream.
    bootStep("housekeeping", "oauth-model-refresh-worker", () =>
      (env.OAUTH_REFRESH_WORKER_ENABLED ? initOAuthModelRefreshWorker() : Promise.resolve()).catch(
        (err) => {
          logger.warn("Could not initialize OAuth model refresh worker", {
            error: getErrorMessage(err),
          });
        },
      ),
    ),
    // Pairing-table cleanup runs unconditionally — pure table-bloat
    // janitor for `model_provider_pairings`, unrelated to the refresh
    // hot path.
    bootStep("housekeeping", "pairing-cleanup-worker", () =>
      initPairingCleanupWorker().catch((err) => {
        logger.warn("Could not initialize OAuth model pairing cleanup worker", {
          error: getErrorMessage(err),
        });
      }),
    ),
    bootStep("housekeeping", "expire-invitations", () =>
      expireOldInvitations()
        .then((expiredCount) => {
          if (expiredCount > 0) logger.info("Expired old invitations", { count: expiredCount });
        })
        .catch((err) => {
          logger.warn("Could not expire old invitations", {
            error: getErrorMessage(err),
          });
        }),
    ),
    bootStep("housekeeping", "cleanup-expired-keys", () =>
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
    ),
    bootStep("housekeeping", "cleanup-expired-uploads", () =>
      cleanupExpiredUploads()
        .then((count) => {
          if (count > 0) logger.info("Removed expired unconsumed uploads", { count });
        })
        .catch((err) => {
          logger.warn("Could not clean up expired uploads", {
            error: getErrorMessage(err),
          });
        }),
    ),
    bootStep("housekeeping", "cleanup-expired-files", () =>
      cleanupExpiredFiles()
        .then((count) => {
          if (count > 0) logger.info("Removed expired files", { count });
        })
        .catch((err) => {
          logger.warn("Could not clean up expired files", {
            error: getErrorMessage(err),
          });
        }),
    ),
  ]);

  // Kick off the recurring upload + file sweeps once initial cleanup is scheduled.
  startUploadGc();
  startFileGc();
  // Transactional storage-deletion outbox worker: drains any boot-time backlog
  // immediately, then polls for due jobs. Purges S3/FS objects whose DB rows
  // were deleted (files, uploads, run workspaces, org/app/end-user cascades).
  startStorageDeletionWorker();
}

/**
 * Apply Drizzle migrations programmatically for PGlite (embedded mode).
 * Delegates to the shared `applyCorePGliteMigrations` helper so the embedded
 * boot path and the tier0 test preload run identical migration logic.
 */
async function applyEmbeddedMigrations(): Promise<void> {
  const { applyCorePGliteMigrations } = await import("./pglite-migrate.ts");
  await applyCorePGliteMigrations(CORE_MIGRATIONS_FOLDER);
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
 * out-of-band), so this covers one side of the mistake: `TRUST_PROXY`
 * enabled in production without an obvious reverse-proxy signal. The
 * other side is a boot failure rather than a warning — `@appstrate/env`
 * refuses `TRUST_PROXY=false` in production behind a non-loopback
 * `APP_URL`, where a proxy is present by construction.
 */
function warnOnTrustProxyMisconfig(trustProxy: string, nodeEnv: string): void {
  if (trustProxy === "false") return;
  const msg =
    `TRUST_PROXY=${trustProxy} — X-Forwarded-For headers will be honored on incoming requests. ` +
    `This is CORRECT only when a trusted reverse proxy (nginx, Traefik, Caddy, cloud LB) ` +
    `is terminating client connections and writing those headers itself. If the server is ` +
    `directly exposed to the internet, any client can spoof their source IP, bypassing every ` +
    `per-IP rate limit (OIDC /oauth2/token, CLI device-flow, auth endpoints). ` +
    `Verify the deployment topology. TRUST_PROXY=false is the right value only when nothing ` +
    `proxies this instance, which in production means a plain-http loopback APP_URL.`;
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
      `repaired (PATCH /api/orgs/:orgId/settings with a supported api_version).`,
    {
      supportedVersions: supported,
      currentVersion: CURRENT_API_VERSION,
      orgs: offenders.map((o) => ({ orgId: o.id, pinnedVersion: o.apiVersion })),
    },
  );
}

/**
 * Boot-time reachability probe for `USERCONTENT_URL`.
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
