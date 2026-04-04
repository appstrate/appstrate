// SPDX-License-Identifier: Apache-2.0

import { and, eq, lt } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { oauthStates, packages, packageVersions } from "@appstrate/db/schema";
import { expireOldInvitations } from "../services/invitations.ts";
import { cleanupExpiredKeys } from "../services/api-keys.ts";
import { createNotifyTriggers } from "@appstrate/db/notify";
import { logger } from "./logger.ts";
import { loadCloud } from "./cloud-loader.ts";
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
import { initWebhookWorker } from "../services/webhooks.ts";
import { initCancelSubscriber } from "../services/run-tracker.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { ensureBucket } from "@appstrate/db/storage";
import { logInfraMode } from "../infra/index.ts";

export async function boot(): Promise<void> {
  // Attempt to load cloud module (no-op in OSS — sets _cloud to null)
  await loadCloud();

  // Log infrastructure mode (storage, queue, pubsub, cache, rate-limit)
  const env = (await import("@appstrate/env")).getEnv();
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
      logger.warn("Could not initialize scheduler", {
        error: err instanceof Error ? err.message : String(err),
      });
    }),
    Promise.resolve(initWebhookWorker()).catch((err) => {
      logger.warn("Could not initialize webhook worker", {
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
      orgId: null,
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
