// SPDX-License-Identifier: Apache-2.0

/**
 * Run-workspace object layout + files-manifest parsing.
 *
 * A run's provisioning objects all live under its runId in the `run-workspace`
 * bucket:
 *
 *   `<runId>.afps`                  the AFPS bundle (manifest + prompt + skills)
 *   `<runId>/manifest.json`         the files manifest (also the DELETION INDEX)
 *   `<runId>/files/<name>`          one object per input file
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
 * ONE key. The pre-#1177 `documents` twin is gone from both the written object
 * and the reader: the platform validates its runtime image tags against its own
 * version at boot, so the container reading this manifest is never older than
 * the platform that wrote it.
 */
export interface RunFilesManifest {
  files: RunFileMeta[];
}

/** Key of a run's AFPS bundle. */
export const runWorkspaceBundleKey = (runId: string): string => `${runId}.afps`;

/** Key of a run's files manifest (the deletion index). */
export const runWorkspaceManifestKey = (runId: string): string => `${runId}/manifest.json`;

/**
 * Key of one input file inside a run's workspace prefix.
 *
 * The `files/` segment is a STORAGE LAYOUT: every input object of every
 * provisioned run lives under it, and the deletion index resolves teardown keys
 * through this same builder. It was spelled `documents/` until the #1177 rename
 * was finished at the physical layer. Changing it again strands the objects of
 * every in-flight run — with no error until a fetch 404s mid-provisioning — so
 * it moves only alongside a pass over the objects already stored.
 */
export const runWorkspaceFileKey = (runId: string, workspaceName: string): string =>
  `${runId}/files/${workspaceName}`;

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
 * name containing a separator) would escape the run's `files/` prefix when
 * concatenated into a key.
 */
function isSafeSegment(name: string): boolean {
  return (
    name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\")
  );
}

/**
 * Parse + validate a files manifest read from storage. `files` is the only key
 * read: an object still carrying the pre-#1177 `documents` spelling throws
 * here — an explicit `Invalid run workspace manifest` on both the serve path
 * (500) and the deletion path (retry, then dead letter) rather than an agent
 * booting with an empty workspace or a teardown silently skipping every input
 * object. Throws on anything else that is not a well-formed manifest too: bad
 * JSON, `files` absent or not an array, an entry that is not an object, a
 * non-string `workspace_name`, or a `workspace_name` that is not a single safe
 * path segment.
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
  const root = parsed as { files?: unknown } | null;
  const files = root?.files;
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
  return { files: entries };
}
