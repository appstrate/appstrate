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
 * Everything for a run is keyed under its runId and deleted through the
 * transactional outbox on teardown. The manifest doubles as the deletion
 * index, so cleanup needs no storage `list` primitive.
 */

import * as storage from "@appstrate/db/storage";
import { db } from "@appstrate/db/client";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../lib/logger.ts";
import { assertUniqueWorkspaceNames } from "./run-document-naming.ts";
import { enqueueStorageDeletion } from "./storage-deletion.ts";

const BUCKET = "run-workspace";

/**
 * Manifest entry the agent uses to enumerate + fetch its documents.
 *
 * `name` is the human display name; `workspace_name` (snake_case on the wire)
 * is the unique single-segment filename the agent writes into
 * `workspace/documents/` and fetches the bytes by. The two are separated so two
 * documents sharing a display name never overwrite each other on disk — see
 * run-document-naming.ts.
 */
export interface RunDocumentMeta {
  name: string;
  workspace_name: string;
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
 * Run-workspace bucket + key builders, exported so cascade-delete paths (org /
 * application delete) can enqueue a run's bundle + manifest keys into the
 * transactional deletion outbox without downloading the manifest inside their
 * transaction. The worker expands a manifest job into its document objects,
 * deleting the manifest last so retries retain the deletion index.
 */
export const RUN_WORKSPACE_BUCKET = BUCKET;
export const runWorkspaceBundleKey = bundleKey;
export const runWorkspaceManifestKey = manifestKey;

/**
 * Stream a single input document into the run's workspace storage. The bytes
 * are piped from the source stream straight to the document object without
 * being buffered in API memory — the platform never holds the whole document.
 *
 * Documents are streamed in during upload-consume (before the run launches),
 * not packaged with the bundle, so the manifest is written separately once all
 * documents have streamed (see {@link writeRunDocumentsManifest}).
 */
export function streamRunDocument(
  runId: string,
  name: string,
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  return storage.uploadStream(BUCKET, documentKey(runId, name), stream);
}

/**
 * Write the documents manifest the agent uses to enumerate + fetch its inputs.
 * Called once, after every document for the run has been streamed in. Asserts
 * the workspace names are unique before persisting — the manifest doubles as
 * the container provisioning index, and a duplicate would silently overwrite a
 * document on disk (400 `duplicate_document_name`).
 */
export function writeRunDocumentsManifest(
  runId: string,
  documents: RunDocumentMeta[],
): Promise<string> {
  assertUniqueWorkspaceNames(documents.map((d) => d.workspace_name));
  const manifest: RunDocumentsManifest = { documents };
  return storage.uploadFile(
    BUCKET,
    manifestKey(runId),
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
}

/**
 * Upload the run's AFPS bundle (`agent-package.afps` = manifest + prompt +
 * skills). Small and constant — stored verbatim; the agent writes it straight
 * to its workspace root. Input documents are streamed separately during
 * upload-consume. No-op when the run has no package.
 */
export async function uploadRunBundle(
  runId: string,
  bundle: Buffer | Uint8Array | undefined,
): Promise<void> {
  if (!bundle) return;
  await storage.uploadFile(BUCKET, bundleKey(runId), bundle);
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
 * Roll back documents streamed in during upload-consume when a run aborts
 * before its row + bundle exist (e.g. a size/MIME mismatch or input-validation
 * failure mid-trigger). The manifest is not yet the deletion index at this
 * stage — it may be absent or partial — so the caller passes the doc names it
 * attempted.
 *
 * The run row never committed, so there is no business transaction to join: the
 * deletions go through the transactional outbox in their OWN short transaction
 * (the durable record), and the worker performs the idempotent physical delete.
 * Never throws (best-effort caller contract) — a failed enqueue is logged, not
 * propagated, so it can't mask the failure the caller is already unwinding.
 */
export async function deleteRunDocuments(runId: string, names: string[]): Promise<void> {
  const keys = [manifestKey(runId), ...names.map((n) => documentKey(runId, n))];
  try {
    await db.transaction((tx) =>
      enqueueStorageDeletion(
        tx,
        keys.map((k) => ({ bucket: BUCKET, storageKey: k, reason: "run_input_rollback" })),
      ),
    );
  } catch (error) {
    logger.warn("Failed to enqueue run document rollback deletion (best-effort)", {
      runId,
      error: getErrorMessage(error),
    });
  }
}

/**
 * Delete all of a run's workspace storage — bundle, documents, and manifest.
 * Never throws (best-effort caller contract). The manifest is the deletion
 * index (no storage `list` primitive needed); when it is already gone we still
 * drop the bundle. The physical deletes go through the transactional deletion
 * outbox: all keys are enqueued in one transaction so a crash mid-teardown
 * can't silently orphan a subset — the worker performs the idempotent deletes.
 */
export async function deleteRunWorkspace(runId: string): Promise<void> {
  try {
    const manifest = await downloadRunDocumentsManifest(runId);
    const keys = [bundleKey(runId)];
    if (manifest) {
      keys.push(manifestKey(runId));
      // Manifests written before `workspace_name` existed key documents on
      // `name` — fall back so pre-upgrade runs still clean up fully.
      for (const d of manifest.documents) keys.push(documentKey(runId, d.workspace_name ?? d.name));
    }
    await db.transaction((tx) =>
      enqueueStorageDeletion(
        tx,
        keys.map((k) => ({ bucket: BUCKET, storageKey: k, reason: "run_workspace_deleted" })),
      ),
    );
  } catch (error) {
    logger.warn("Failed to enqueue run workspace deletion (best-effort)", {
      runId,
      error: getErrorMessage(error),
    });
  }
}
