// SPDX-License-Identifier: Apache-2.0

/**
 * Run-workspace object layout + documents-manifest parsing.
 *
 * A run's provisioning objects all live under its runId in the `run-workspace`
 * bucket:
 *
 *   `<runId>.afps`                  the AFPS bundle (manifest + prompt + skills)
 *   `<runId>/manifest.json`         the documents manifest (also the DELETION INDEX)
 *   `<runId>/documents/<name>`      one object per input document
 *
 * The manifest doubles as the deletion index — teardown enqueues the bundle and
 * the manifest key, and the outbox worker expands the manifest into its document
 * keys (see `storage-deletion.ts`). That means the manifest is parsed by TWO
 * consumers with different trust postures: the route that serves it to the
 * container, and the worker that turns each entry into a key it deletes. Both go
 * through {@link parseRunDocumentsManifest} — a name that is not a single safe
 * path segment would otherwise let a corrupted/tampered manifest steer a
 * deletion (or a read) out of the run's own prefix.
 *
 * This module is a LEAF: it holds no I/O and imports nothing from the service
 * graph, so both `run-workspace-storage.ts` (which enqueues deletions) and
 * `storage-deletion.ts` (which executes them) can depend on it without a cycle.
 */

/** Bucket holding every per-run provisioning object. */
export const RUN_WORKSPACE_BUCKET = "run-workspace";

/**
 * Manifest entry the agent uses to enumerate + fetch its documents.
 *
 * `name` is the human display name; `workspace_name` (snake_case on the wire) is
 * the unique single-segment filename the agent writes into `workspace/documents/`
 * and fetches the bytes by. The two are separated so two documents sharing a
 * display name never overwrite each other on disk — see run-document-naming.ts.
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

/** Key of a run's AFPS bundle. */
export const runWorkspaceBundleKey = (runId: string): string => `${runId}.afps`;

/** Key of a run's documents manifest (the deletion index). */
export const runWorkspaceManifestKey = (runId: string): string => `${runId}/manifest.json`;

/** Key of one input document inside a run's workspace prefix. */
export const runWorkspaceDocumentKey = (runId: string, workspaceName: string): string =>
  `${runId}/documents/${workspaceName}`;

/** Matches a documents-manifest key, capturing the runId that owns it. */
const MANIFEST_KEY_RE = /^([^/]+)\/manifest\.json$/;

/**
 * The runId owning a manifest key, or null when the key is not a manifest. Used
 * by the outbox worker to decide whether a job is a plain object delete or a
 * manifest expansion.
 */
export function parseRunWorkspaceManifestKey(storageKey: string): string | null {
  return MANIFEST_KEY_RE.exec(storageKey)?.[1] ?? null;
}

/**
 * Is `name` a single, safe path segment? Anything else (empty, `.`, `..`, or a
 * name containing a separator) would escape the run's `documents/` prefix when
 * concatenated into a key.
 */
function isSafeSegment(name: string): boolean {
  return (
    name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\")
  );
}

/**
 * Parse + validate a documents manifest read from storage. Throws on anything
 * that is not a well-formed manifest: bad JSON, a missing/!array `documents`,
 * an entry that is not an object, a non-string `workspace_name`, or a
 * `workspace_name` that is not a single safe path segment.
 *
 * Strict by design — this is the ONE reader for both the serve path and the
 * deletion path, and both derive object keys from `workspace_name`. Failing
 * loudly on a malformed manifest keeps a corrupted index from either serving the
 * wrong bytes or deleting outside the run's prefix; the deletion job simply
 * retries and surfaces as a dead letter rather than silently traversing.
 */
export function parseRunDocumentsManifest(
  bytes: Uint8Array,
  storageKey: string,
): RunDocumentsManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`Invalid run workspace manifest (not JSON): ${storageKey}`);
  }
  const documents = (parsed as { documents?: unknown } | null)?.documents;
  if (!Array.isArray(documents)) {
    throw new Error(`Invalid run workspace manifest: ${storageKey}`);
  }
  return {
    documents: documents.map((entry) => {
      const e = entry as Partial<RunDocumentMeta> | null;
      const workspaceName = e?.workspace_name;
      if (typeof workspaceName !== "string" || !isSafeSegment(workspaceName)) {
        throw new Error(`Invalid document name in run workspace manifest: ${storageKey}`);
      }
      return {
        name: typeof e?.name === "string" ? e.name : workspaceName,
        workspace_name: workspaceName,
        size: typeof e?.size === "number" ? e.size : 0,
      };
    }),
  };
}

/**
 * Every in-bucket document key a manifest names, de-duplicated. The keys are
 * safe by construction — {@link parseRunDocumentsManifest} has already rejected
 * any entry whose name is not a single path segment.
 */
export function runWorkspaceDocumentKeys(runId: string, manifest: RunDocumentsManifest): string[] {
  return [...new Set(manifest.documents.map((d) => d.workspace_name))].map((name) =>
    runWorkspaceDocumentKey(runId, name),
  );
}
