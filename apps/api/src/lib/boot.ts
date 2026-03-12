import { and, eq, lt } from "drizzle-orm";
import { db } from "./db.ts";
import {
  oauthStates,
  scheduleRuns,
  organizations,
  packages,
  packageVersions,
  providerCredentials,
} from "@appstrate/db/schema";
import { expireOldInvitations } from "../services/invitations.ts";
import { cleanupExpiredKeys } from "../services/api-keys.ts";
import { createNotifyTriggers } from "@appstrate/db/notify";
import { logger } from "./logger.ts";
import { initRealtime } from "../services/realtime.ts";
import { initSystemProxies } from "../services/proxy-registry.ts";
import { initSystemModels } from "../services/model-registry.ts";
import { initSystemPackages, getSystemPackages } from "../services/system-packages.ts";
import { createVersionAndUpload } from "../services/package-versions.ts";
import { setFlowItems, PROVIDER_CONFIG } from "../services/package-items.ts";
import { extractDepsFromManifest } from "../lib/manifest-utils.ts";
import type { Manifest } from "@appstrate/core/validation";
import { markOrphanExecutionsFailed } from "../services/state.ts";
import { initScheduler } from "../services/scheduler.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { ensureStorageBucket } from "../services/package-storage.ts";
import { ensurePackageItemsBucket } from "../services/package-items.ts";
import { initRegistryProvider } from "../services/registry-provider.ts";

export async function boot(): Promise<void> {
  // Load system proxies from SYSTEM_PROXIES env var
  initSystemProxies();
  logger.info("System proxies loaded");

  // Load system models from SYSTEM_MODELS env var
  initSystemModels();
  logger.info("System models loaded");

  // Load all system packages (providers + skills + extensions + flows) from ZIPs
  await initSystemPackages();

  // Sync system packages to DB for all orgs (with registry-grade versioning)
  await syncSystemPackages().catch((err) => {
    logger.warn("Could not sync system packages", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Backfill provider deps from manifest → packageDependencies for existing flows
  await backfillFlowProviderDeps().catch((err) => {
    logger.warn("Could not backfill flow provider deps", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

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

  // Parallel init: sidecar pool, scheduler, and DB cleanups are all independent
  await Promise.all([
    orchestrator.initialize().catch((err) => {
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

/**
 * Sync system packages to the DB for all existing orgs.
 * Upserts packages rows (source: "system"), providerCredentials (per org, for providers only),
 * and packageVersions with SHA256 SRI integrity.
 */
async function syncSystemPackages(): Promise<void> {
  const allPackages = getSystemPackages();
  if (allPackages.size === 0) return;

  const orgs = await db.select({ id: organizations.id }).from(organizations);

  let synced = 0;
  for (const [id, entry] of allPackages) {
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

    // 2. UPSERT providerCredentials per org (only for providers)
    if (type === "provider") {
      for (const org of orgs) {
        await db
          .insert(providerCredentials)
          .values({ providerId: id, orgId: org.id })
          .onConflictDoNothing();
      }
    }

    // 3. Create version from pre-built ZIP (idempotent — skips if version exists)
    await createVersionAndUpload({
      packageId: id,
      version,
      orgId: null,
      createdBy: null,
      zipBuffer,
      manifest: manifest as unknown as Record<string, unknown>,
    });

    synced++;
  }

  logger.info("System packages synced", { packages: synced, orgs: orgs.length });
}

/** Backfill provider deps from manifest → packageDependencies for existing flows.
 *  Ensures flows created before provider unification get their provider deps populated. */
async function backfillFlowProviderDeps(): Promise<void> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);

  let total = 0;
  for (const org of orgs) {
    const orgFlows = await db
      .select({ id: packages.id, draftManifest: packages.draftManifest })
      .from(packages)
      .where(and(eq(packages.orgId, org.id), eq(packages.type, "flow")));

    for (const flow of orgFlows) {
      const { providerIds } = extractDepsFromManifest(flow.draftManifest as Partial<Manifest>);
      if (providerIds.length > 0) {
        await setFlowItems(flow.id, org.id, providerIds, PROVIDER_CONFIG);
        total++;
      }
    }
  }

  if (total > 0) {
    logger.info("Backfilled provider deps for flows", { flows: total });
  }
}
