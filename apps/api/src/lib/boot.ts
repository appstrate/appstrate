import { and, eq, lt } from "drizzle-orm";
import { db } from "./db.ts";
import { oauthStates, packages, packageVersions } from "@appstrate/db/schema";
import { expireOldInvitations } from "../services/invitations.ts";
import { cleanupExpiredKeys } from "../services/api-keys.ts";
import { createNotifyTriggers } from "@appstrate/db/notify";
import { logger } from "./logger.ts";
import { initRealtime } from "../services/realtime.ts";
import { initSystemProxies } from "../services/proxy-registry.ts";
import { initSystemModels } from "../services/model-registry.ts";
import { initSystemPackages, getSystemPackages } from "../services/system-packages.ts";
import { createVersionAndUpload } from "../services/package-versions.ts";
import { uploadPackageFiles, SYSTEM_STORAGE_NAMESPACE } from "../services/package-items.ts";
import { markOrphanExecutionsFailed } from "../services/state.ts";
import { initScheduleWorker } from "../services/scheduler.ts";
import { initCancelSubscriber } from "../services/execution-tracker.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { ensureBucket } from "@appstrate/db/storage";

export async function boot(): Promise<void> {
  // Verify S3 bucket is accessible (fail-fast if misconfigured)
  await ensureBucket();
  logger.info("S3 bucket verified");

  // Load system proxies from SYSTEM_PROXIES env var
  initSystemProxies();
  logger.info("System proxies loaded");

  // Load system models from SYSTEM_MODELS env var
  initSystemModels();
  logger.info("System models loaded");

  // Load all system packages (providers + skills + tools + flows) from ZIPs
  await initSystemPackages();

  // Sync system packages to DB + upload files to global _system/ namespace
  await syncSystemPackages().catch((err) => {
    logger.warn("Could not sync system packages", {
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

  // Initialize cross-instance cancel subscriber (no-op without Redis)
  initCancelSubscriber();

  // Parallel init: sidecar pool, scheduler, and DB cleanups are all independent
  const parallelInits: Promise<void>[] = [
    orchestrator.initialize().catch((err) => {
      logger.warn("Could not initialize sidecar pool", {
        error: err instanceof Error ? err.message : String(err),
      });
    }),
    initScheduleWorker().catch((err) => {
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
  ];

  await Promise.all(parallelInits);
}

/**
 * Sync system packages to the DB.
 * Upserts packages rows (source: "system"), uploads files to global _system/ namespace,
 * and creates packageVersions with SHA256 SRI integrity.
 */
async function syncSystemPackages(): Promise<void> {
  const allPackages = getSystemPackages();
  if (allPackages.size === 0) return;

  let synced = 0;
  for (const [id, entry] of allPackages) {
    try {
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
          type as "flows" | "skills" | "tools" | "providers",
          SYSTEM_STORAGE_NAMESPACE,
          id,
          entry.files,
        );
      }

      // 3. Create version from pre-built ZIP (idempotent — skips if version exists)
      // This uploads to S3 then inserts the version row.
      await createVersionAndUpload({
        packageId: id,
        version,
        orgId: null,
        createdBy: null,
        zipBuffer,
        manifest: manifest as unknown as Record<string, unknown>,
      });

      synced++;
    } catch (err) {
      // Per-package error isolation: log and continue with remaining packages
      logger.warn("Failed to sync system package", {
        packageId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("System packages synced", { packages: synced });
}
