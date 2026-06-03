// SPDX-License-Identifier: Apache-2.0

/**
 * Per-run workspace provisioning storage.
 *
 * The agent container self-provisions its workspace at startup. Two payloads,
 * delivered separately by nature:
 *
 *   - **Bundle** (`agent-package.afps` = manifest + prompt + skills): small and
 *     constant. Stored verbatim, fetched via `GET /api/runs/:runId/workspace`,
 *     and written straight to the workspace root.
 *   - **Input documents** (user uploads): large and variable. Each is stored as
 *     its own object and fetched via `GET /api/runs/:runId/documents/:name`,
 *     enumerated through the manifest at `GET /api/runs/:runId/documents`. The
 *     agent streams each straight to `documents/<name>` on disk, so it never
 *     buffers the whole payload — bounding agent memory regardless of upload
 *     size.
 *
 * Routing delivery through a platform fetch (rather than seeding a shared run
 * volume) makes the workspace volume pure agent-local scratch, so its backing
 * (disk or tmpfs) is a free performance choice — a tmpfs-backed `local` volume
 * is NOT shared between the seed helper and the agent (see issue #549).
 *
 * Everything for a run is keyed under its runId and deleted (best-effort) on
 * teardown. The manifest doubles as the deletion index, so cleanup needs no
 * storage `list` primitive.
 */

import * as storage from "@appstrate/db/storage";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../lib/logger.ts";

const BUCKET = "run-workspace";

/** One input document destined for the agent's `documents/<name>`. */
export interface RunDocument {
  /** Sanitised filename, no path prefix. */
  name: string;
  content: Buffer | Uint8Array;
}

/** What a run carries into its workspace: the AFPS bundle + input documents. */
export interface RunWorkspaceUpload {
  /** `agent-package.afps` bytes. Omitted only when the run has no package. */
  bundle?: Buffer | Uint8Array;
  documents: RunDocument[];
}

/** Manifest entry the agent uses to enumerate + fetch its documents. */
export interface RunDocumentMeta {
  name: string;
  size: number;
}

/** The documents manifest served at `GET /api/runs/:runId/documents`. */
export interface RunDocumentsManifest {
  documents: RunDocumentMeta[];
}

const bundleKey = (runId: string): string => `${runId}.afps`;
const manifestKey = (runId: string): string => `${runId}/manifest.json`;
const documentKey = (runId: string, name: string): string => `${runId}/documents/${name}`;

/**
 * Provision a run's workspace storage: the bundle (`agent-package.afps`), one
 * object per input document, and the documents manifest. Overwrites any
 * existing objects (a run id is single-use). No-op for an absent bundle and no
 * documents.
 */
export async function uploadRunWorkspace(runId: string, upload: RunWorkspaceUpload): Promise<void> {
  const ops: Promise<unknown>[] = [];

  if (upload.bundle) {
    // The bundle is the `.afps` package — itself a ZIP the agent runtime reads.
    // Stored verbatim (no extra archive wrapper); the agent writes it straight
    // to its workspace root.
    ops.push(storage.uploadFile(BUCKET, bundleKey(runId), upload.bundle));
  }

  if (upload.documents.length > 0) {
    for (const doc of upload.documents) {
      ops.push(storage.uploadFile(BUCKET, documentKey(runId, doc.name), doc.content));
    }
    const manifest: RunDocumentsManifest = {
      documents: upload.documents.map((d) => ({ name: d.name, size: d.content.byteLength })),
    };
    ops.push(
      storage.uploadFile(
        BUCKET,
        manifestKey(runId),
        new TextEncoder().encode(JSON.stringify(manifest)),
      ),
    );
  }

  await Promise.all(ops);
}

/** Fetch the run's bundle (`agent-package.afps` bytes). Returns null when none. */
export async function downloadRunWorkspace(runId: string): Promise<Buffer | null> {
  const data = await storage.downloadFile(BUCKET, bundleKey(runId));
  return data ? Buffer.from(data) : null;
}

/** Fetch the run's documents manifest. Returns null when the run has none. */
export async function downloadRunDocumentsManifest(
  runId: string,
): Promise<RunDocumentsManifest | null> {
  const data = await storage.downloadFile(BUCKET, manifestKey(runId));
  if (!data) return null;
  return JSON.parse(new TextDecoder().decode(data)) as RunDocumentsManifest;
}

/** Stream a single run document. Returns null when absent. */
export function downloadRunDocumentStream(
  runId: string,
  name: string,
): Promise<ReadableStream<Uint8Array> | null> {
  return storage.downloadStream(BUCKET, documentKey(runId, name));
}

/**
 * Delete all of a run's workspace storage — bundle, documents, and manifest.
 * Best-effort: never throws. The manifest is the deletion index (no storage
 * `list` primitive needed); when it is already gone we still drop the bundle.
 */
export async function deleteRunWorkspace(runId: string): Promise<void> {
  try {
    const manifest = await downloadRunDocumentsManifest(runId);
    const keys = [bundleKey(runId)];
    if (manifest) {
      keys.push(manifestKey(runId));
      for (const d of manifest.documents) keys.push(documentKey(runId, d.name));
    }
    await Promise.all(keys.map((k) => storage.deleteFile(BUCKET, k)));
  } catch (error) {
    logger.warn("Failed to delete run workspace (best-effort)", {
      runId,
      error: getErrorMessage(error),
    });
  }
}
