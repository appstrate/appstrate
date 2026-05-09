// SPDX-License-Identifier: Apache-2.0

import { zipArtifact, unzipArtifact, type Zippable } from "@appstrate/core/zip";
import { verifyArtifactIntegrity } from "@appstrate/core/integrity";
import * as storage from "@appstrate/db/storage";
import { logger } from "../lib/logger.ts";
import type { LoadedPackage } from "../types/index.ts";
import {
  buildBundleFromCatalog,
  formatPackageIdentity,
  writeBundleToBuffer,
  type Bundle,
  type BundlePackage,
} from "@appstrate/afps-runtime/bundle";
import { DraftPackageCatalog } from "./run-launcher/draft-package-catalog.ts";
import { loadAndVerifyBundle } from "./run-launcher/bundle-signature-policy.ts";

const BUCKET = "agent-packages";
const ZIP_COMPRESSION_LEVEL = 6;

/**
 * Download a versioned package ZIP from Storage.
 *
 * Two orthogonal integrity checks are applied when the inputs are
 * present:
 *
 *   1. `expectedIntegrity` (SRI sha256 over the raw ZIP bytes, stored in
 *      `package_versions.integrity` when the version was published) —
 *      detects storage corruption and tampering of the artifact at
 *      rest.
 *   2. AFPS bundle signature (`signature.sig` inside the ZIP, verified
 *      against the `AFPS_TRUST_ROOT` + `AFPS_SIGNATURE_POLICY` env
 *      config) — detects tampering by anyone who could have written
 *      the ZIP since it was signed by the publisher.
 *
 * Returns `null` if the object does not exist. Throws on integrity or
 * (under policy=required) signature failure.
 */
export async function downloadVersionZip(
  packageId: string,
  version: string,
  expectedIntegrity?: string | null,
): Promise<Buffer | null> {
  const path = `${packageId}/${version}.afps`;
  const data = await storage.downloadFile(BUCKET, path);
  if (!data) return null;

  const bytes = new Uint8Array(data);

  if (expectedIntegrity) {
    const result = verifyArtifactIntegrity(bytes, expectedIntegrity);
    if (!result.valid) {
      logger.error("Integrity mismatch on version download", {
        packageId,
        version,
        expected: expectedIntegrity,
        computed: result.computed,
      });
      throw new Error(`Integrity check failed for ${packageId}@${version}`);
    }
  }

  // Signature policy is applied here (and not inside the unzip path)
  // so every code path that pulls a bundle from storage goes through
  // the same gate: run path, re-publish, dependency resolution, etc.
  await loadAndVerifyBundle(bytes, packageId);

  return Buffer.from(data);
}

/** Delete a versioned package ZIP from Storage. Swallows errors (best-effort cleanup). */
export async function deleteVersionZip(packageId: string, version: string): Promise<void> {
  const path = `${packageId}/${version}.afps`;
  try {
    await storage.deleteFile(BUCKET, path);
  } catch (error) {
    logger.warn("Failed to delete version ZIP (best-effort)", {
      packageId,
      version,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Upload a package ZIP to Storage. */
export async function uploadPackageZip(
  packageId: string,
  version: string,
  zipBuffer: Buffer,
): Promise<void> {
  const path = `${packageId}/${version}.afps`;
  try {
    await storage.uploadFile(BUCKET, path, zipBuffer);
  } catch (error) {
    logger.error("Failed to upload agent package", {
      packageId,
      version,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

interface AgentPackageResult {
  zip: Buffer;
  /**
   * Parsed in-memory bundle — shared with `prompt-builder.ts` so the
   * platform system prompt derives tools / skills / providers /
   * schemas from the SAME source the runner-pi container will load.
   */
  bundle: Bundle;
}

/**
 * Build a multi-package `.afps-bundle` for the run hot path and
 * extract TOOL.md docs in a single pass.
 *
 * The returned ZIP is the canonical bundle format (bundle.json root +
 * per-package dirs under `packages/@scope/name/version/`). The
 * container-side loader (`readBundleFromFile` in runtime-pi) parses
 * it directly into a {@link Bundle} the PiRunner + resolvers consume.
 *
 * Dependency resolution uses {@link DraftPackageCatalog}, which reads
 * draft manifests + the `package-items` storage bucket — NOT published
 * versions. This preserves the legacy "edit tool → next run sees it"
 * behaviour on the dev loop.
 */
export async function buildAgentPackage(
  agent: LoadedPackage,
  orgId: string,
): Promise<AgentPackageResult> {
  const manifest = agent.manifest as Record<string, unknown>;
  const name = typeof manifest.name === "string" ? manifest.name : null;
  const version = typeof manifest.version === "string" ? manifest.version : null;
  if (!name || !version || !name.startsWith("@") || !name.includes("/")) {
    throw new Error(
      `buildAgentPackage: agent ${agent.id} has no valid scoped name/version in its manifest`,
    );
  }

  const rootFiles = new Map<string, Uint8Array>([
    ["manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2))],
    ["prompt.md", new TextEncoder().encode(agent.prompt)],
  ]);
  const root: BundlePackage = {
    identity: formatPackageIdentity(name as `@${string}/${string}`, version),
    manifest,
    files: rootFiles,
    integrity: "",
  };

  const bundle = await buildBundleFromCatalog(root, new DraftPackageCatalog({ orgId }), {
    onWarn: (message) => {
      logger.warn("buildAgentPackage: bundle builder warning", { agentId: agent.id, message });
    },
  });

  const zipBuffer = writeBundleToBuffer(bundle);

  return { zip: Buffer.from(zipBuffer), bundle };
}

/** Build a minimal ZIP with just manifest.json + a content file (default: prompt.md). */
export function buildMinimalZip(
  manifest: Record<string, unknown>,
  content: string,
  contentFileName = "prompt.md",
): Buffer {
  const entries: Zippable = {
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    [contentFileName]: new TextEncoder().encode(content),
  };
  return Buffer.from(zipArtifact(entries, ZIP_COMPRESSION_LEVEL));
}

/**
 * Unzip a buffer and normalize (strip __MACOSX, directory entries).
 * Returns a map of path → content as Uint8Array.
 */
export function unzipAndNormalize(zipBuffer: Buffer): Record<string, Uint8Array> {
  return unzipArtifact(new Uint8Array(zipBuffer));
}
