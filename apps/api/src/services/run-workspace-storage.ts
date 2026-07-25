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
import { enqueueStorageDeletion, type StorageDeletionJobInput } from "./storage-deletion.ts";
import {
  RUN_WORKSPACE_BUCKET,
  runWorkspaceBundleKey,
  runWorkspaceDocumentKey,
  runWorkspaceManifestKey,
  parseRunDocumentsManifest,
  type RunDocumentMeta,
  type RunDocumentsManifest,
} from "./run-workspace-manifest.ts";

/**
 * The deletion-outbox jobs that purge every object of a run's workspace: the
 * bundle plus the manifest, which the worker expands into the run's document
 * objects. Two bounded rows per run, no storage I/O — so ANY caller (run
 * finalize, org/application cascade) can enqueue them inside the very
 * transaction that makes the run's deletion durable.
 */
export function runWorkspaceDeletionJobs(runId: string, reason: string): StorageDeletionJobInput[] {
  return [
    { bucket: RUN_WORKSPACE_BUCKET, storageKey: runWorkspaceBundleKey(runId), reason },
    { bucket: RUN_WORKSPACE_BUCKET, storageKey: runWorkspaceManifestKey(runId), reason },
  ];
}

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
  return storage.uploadStream(RUN_WORKSPACE_BUCKET, runWorkspaceDocumentKey(runId, name), stream);
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
    RUN_WORKSPACE_BUCKET,
    runWorkspaceManifestKey(runId),
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
  await storage.uploadFile(RUN_WORKSPACE_BUCKET, runWorkspaceBundleKey(runId), bundle);
}

/** Fetch the run's bundle (`agent-package.afps` bytes). Returns null when none. */
export async function downloadRunWorkspace(runId: string): Promise<Buffer | null> {
  const data = await storage.downloadFile(RUN_WORKSPACE_BUCKET, runWorkspaceBundleKey(runId));
  return data ? Buffer.from(data) : null;
}

/**
 * Fetch + validate the run's documents manifest. Returns null when the run has
 * none. Parsing goes through the ONE strict reader shared with the deletion
 * worker, so a corrupted manifest is rejected here instead of being served to
 * the container as-is.
 */
export async function downloadRunDocumentsManifest(
  runId: string,
): Promise<RunDocumentsManifest | null> {
  const key = runWorkspaceManifestKey(runId);
  const data = await storage.downloadFile(RUN_WORKSPACE_BUCKET, key);
  if (!data) return null;
  return parseRunDocumentsManifest(data, key);
}

/** Stream a single run document. Returns null when absent. */
export function downloadRunDocumentStream(
  runId: string,
  name: string,
): Promise<ReadableStream<Uint8Array> | null> {
  return storage.downloadStream(RUN_WORKSPACE_BUCKET, runWorkspaceDocumentKey(runId, name));
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
  const keys = [
    runWorkspaceManifestKey(runId),
    ...names.map((n) => runWorkspaceDocumentKey(runId, n)),
  ];
  try {
    await db.transaction((tx) =>
      enqueueStorageDeletion(
        tx,
        keys.map((k) => ({
          bucket: RUN_WORKSPACE_BUCKET,
          storageKey: k,
          reason: "run_input_rollback",
        })),
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
 * Never throws (best-effort caller contract).
 *
 * NO storage read happens here. The two keys are enqueued unconditionally and
 * the WORKER expands the manifest into the run's document objects (with retry,
 * backoff and dead-letter visibility). Reading the manifest first — to derive
 * the document keys eagerly — made a transient storage failure (S3 503, MinIO
 * timeout) enqueue NOTHING at all: the run is terminal, nothing revisits it, and
 * the orphan-reconciliation script only scans the `documents` bucket, so those
 * bytes would be stranded forever. Enqueue-first is the invariant: a confirmed
 * teardown is always replayable until the objects physically disappear.
 */
export async function deleteRunWorkspace(runId: string): Promise<void> {
  try {
    await db.transaction((tx) =>
      enqueueStorageDeletion(tx, runWorkspaceDeletionJobs(runId, "run_workspace_deleted")),
    );
  } catch (error) {
    logger.warn("Failed to enqueue run workspace deletion (best-effort)", {
      runId,
      error: getErrorMessage(error),
    });
  }
}
