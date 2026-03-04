import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lt } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { db } from "./db.ts";
import { oauthStates, scheduleRuns } from "@appstrate/db/schema";
import { expireOldInvitations } from "../services/invitations.ts";
import { cleanupExpiredKeys } from "../services/api-keys.ts";
import { createNotifyTriggers } from "@appstrate/db/notify";
import { logger } from "./logger.ts";
import { initRealtime } from "../services/realtime.ts";
import { initBuiltInProviders } from "@appstrate/connect";
import { initBuiltInProxies } from "../services/proxy-registry.ts";
import { initPackageService, getBuiltInPackageCount } from "../services/flow-service.ts";
import { initBuiltInPackages } from "../services/builtin-packages.ts";
import { markOrphanExecutionsFailed } from "../services/state.ts";
import { cleanupOrphanedContainers } from "../services/docker.ts";
import { initScheduler } from "../services/scheduler.ts";
import { initSidecarPool } from "../services/sidecar-pool.ts";
import { ensureStorageBucket } from "../services/package-storage.ts";
import { ensurePackageItemsBucket } from "../services/package-items.ts";
import { initRegistryProvider } from "../services/registry-provider.ts";

export async function boot(): Promise<void> {
  const env = getEnv();
  const dataDir = env.DATA_DIR;

  if (dataDir) {
    // Load built-in providers from {dataDir}/providers.json + SYSTEM_PROVIDERS env var
    const providersPath = join(dataDir, "providers.json");
    try {
      const fileProviders = JSON.parse(readFileSync(providersPath, "utf-8"));
      initBuiltInProviders(fileProviders);
      logger.info("Built-in providers loaded", { count: fileProviders.length });
    } catch {
      initBuiltInProviders();
      logger.info("Built-in providers loaded (env var only)");
    }

    // Load built-in proxies from {dataDir}/proxies.json + SYSTEM_PROXIES env var
    const proxiesPath = join(dataDir, "proxies.json");
    try {
      const fileProxies = JSON.parse(readFileSync(proxiesPath, "utf-8"));
      initBuiltInProxies(fileProxies);
      logger.info("Built-in proxies loaded", { count: fileProxies.length });
    } catch {
      initBuiltInProxies();
      logger.info("Built-in proxies loaded (env var only)");
    }

    await initPackageService(dataDir);
    logger.info("Built-in flows loaded", { count: getBuiltInPackageCount() });

    await initBuiltInPackages(dataDir);
  } else {
    initBuiltInProviders(); // SYSTEM_PROVIDERS env var still loaded
    initBuiltInProxies(); // SYSTEM_PROXIES env var still loaded
    logger.info("DATA_DIR not set — built-in resources disabled");
  }

  // Initialize registry provider (non-fatal)
  await initRegistryProvider().catch((err) => {
    logger.warn("Could not initialize registry provider", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Parallel init: storage, package items, NOTIFY triggers, and realtime are all independent
  await Promise.all([
    ensureStorageBucket().catch((err) => {
      logger.warn("Could not ensure storage bucket", {
        error: err instanceof Error ? err.message : String(err),
      });
    }),
    ensurePackageItemsBucket().catch((err) => {
      logger.warn("Could not ensure package items bucket", {
        error: err instanceof Error ? err.message : String(err),
      });
    }),
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

  // Sequential cleanup: orphan executions must be marked before container cleanup,
  // and containers must be cleaned before sidecar pool init.
  try {
    const { count, executionIds } = await markOrphanExecutionsFailed();
    if (count > 0) {
      logger.info("Marked orphaned executions as failed", { count, executionIds });
    }
  } catch (err) {
    logger.warn("Could not clean orphaned executions", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { containers, networks } = await cleanupOrphanedContainers();
    if (containers > 0 || networks > 0) {
      logger.info("Cleaned up orphaned Docker resources", { containers, networks });
    }
  } catch (err) {
    logger.warn("Could not clean up orphaned Docker resources", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Parallel init: sidecar pool, scheduler, and DB cleanups are all independent
  await Promise.all([
    initSidecarPool().catch((err) => {
      logger.warn("Could not initialize sidecar pool", {
        error: err instanceof Error ? err.message : String(err),
      });
    }),
    initScheduler().catch((err) => {
      logger.warn("Could not initialize scheduler", {
        error: err instanceof Error ? err.message : String(err),
      });
    }),
    db
      .delete(oauthStates)
      .where(lt(oauthStates.expiresAt, new Date()))
      .then((deleted) => logger.debug("Cleaned up expired OAuth states", { deleted }))
      .catch((err) => {
        logger.warn("Could not clean up expired OAuth states", {
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
    db
      .delete(scheduleRuns)
      .where(lt(scheduleRuns.createdAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)))
      .then((deleted) => logger.debug("Cleaned up old schedule_runs", { deleted }))
      .catch((err) => {
        logger.warn("Could not clean up old schedule_runs", {
          error: err instanceof Error ? err.message : String(err),
        });
      }),
  ]);
}
