// SPDX-License-Identifier: Apache-2.0

/**
 * Run-workspace object layout + files-manifest parsing.
 *
 * A run's provisioning objects all live under its runId in the `run-workspace`
 * bucket:
 *
 *   `<runId>.afps`                  the AFPS bundle (manifest + prompt + skills)
 *   `<runId>/manifest.json`         the files manifest (also the DELETION INDEX)
 *   `<runId>/documents/<name>`      one object per input file
 *
 * The manifest doubles as the deletion index — teardown enqueues the bundle and
 * the manifest key, and the outbox worker expands the manifest into its file
 * keys (see `storage-deletion.ts`). That means the manifest is parsed by TWO
 * consumers with different trust postures: the route that serves it to the
 * container, and the worker that turns each entry into a key it deletes. Both go
 * through {@link parseRunFilesManifest} — a name that is not a single safe
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
 * Manifest entry the agent uses to enumerate + fetch its files.
 *
 * `name` is the human display name; `workspace_name` (snake_case on the wire) is
 * the unique single-segment filename the agent writes into `workspace/files/`
 * (`workspace/documents/` on a pre-#1177 runtime image)
 * and fetches the bytes by. The two are separated so two files sharing a
 * display name never overwrite each other on disk — see run-file-naming.ts.
 */
export interface RunFileMeta {
  name: string;
  workspace_name: string;
  size: number;
}

/**
 * The files manifest served at `GET /api/runs/:runId/files`.
 *
 * `documents` is the pre-#1177 spelling of the SAME array. It is still WRITTEN
 * (see `writeRunFilesManifest`) and still READ, because the runtime image and
 * the platform deploy independently: a container built before the rename reads
 * `manifest.documents`, and a manifest object written before the rename — a run
 * still in flight, or one whose storage teardown has not run yet — only carries
 * that key. Dropping either half loses input files, or leaks every input object
 * of an in-flight run, with no error on any path.
 */
export interface RunFilesManifest {
  files: RunFileMeta[];
  /** @deprecated Pre-#1177 alias of {@link RunFilesManifest.files}. */
  documents: RunFileMeta[];
}

/** Key of a run's AFPS bundle. */
export const runWorkspaceBundleKey = (runId: string): string => `${runId}.afps`;

/** Key of a run's files manifest (the deletion index). */
export const runWorkspaceManifestKey = (runId: string): string => `${runId}/manifest.json`;

/**
 * Key of one input file inside a run's workspace prefix.
 *
 * The `documents/` segment is a STORAGE LAYOUT, not vocabulary: every object of
 * every run already provisioned lives under it, and the deletion index resolves
 * teardown keys through this same builder. Issue #1177 renamed the identifier,
 * never the literal — changing it would strand the objects of every in-flight
 * run with no error until a fetch 404s mid-provisioning.
 */
export const runWorkspaceFileKey = (runId: string, workspaceName: string): string =>
  `${runId}/documents/${workspaceName}`;

/** Matches a files-manifest key, capturing the runId that owns it. */
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
 * Parse + validate a files manifest read from storage. Accepts `files` or the
 * pre-#1177 `documents` key (a manifest written before the rename is live data
 * the deletion index still has to expand). Throws on anything that is not a
 * well-formed manifest: bad JSON, neither key present or not an array,
 * an entry that is not an object, a non-string `workspace_name`, or a
 * `workspace_name` that is not a single safe path segment.
 *
 * Strict by design — this is the ONE reader for both the serve path and the
 * deletion path, and both derive object keys from `workspace_name`. Failing
 * loudly on a malformed manifest keeps a corrupted index from either serving the
 * wrong bytes or deleting outside the run's prefix; the deletion job simply
 * retries and surfaces as a dead letter rather than silently traversing.
 */
export function parseRunFilesManifest(bytes: Uint8Array, storageKey: string): RunFilesManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`Invalid run workspace manifest (not JSON): ${storageKey}`);
  }
  const root = parsed as { files?: unknown; documents?: unknown } | null;
  const files = Array.isArray(root?.files) ? root.files : root?.documents;
  if (!Array.isArray(files)) {
    throw new Error(`Invalid run workspace manifest: ${storageKey}`);
  }
  const entries = files.map((entry) => {
    const e = entry as Partial<RunFileMeta> | null;
    const workspaceName = e?.workspace_name;
    if (typeof workspaceName !== "string" || !isSafeSegment(workspaceName)) {
      throw new Error(`Invalid file name in run workspace manifest: ${storageKey}`);
    }
    return {
      name: typeof e?.name === "string" ? e.name : workspaceName,
      workspace_name: workspaceName,
      size: typeof e?.size === "number" ? e.size : 0,
    };
  });
  return { files: entries, documents: entries };
}
