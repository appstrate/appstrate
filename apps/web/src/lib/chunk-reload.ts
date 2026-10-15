// SPDX-License-Identifier: Apache-2.0

// One-shot reload for stale-chunk failures: after a redeploy an open tab 404s on old chunk
// hashes and React caches the rejected `lazy()` payload, so only a hard reload recovers.
// Loop guard: a sessionStorage flag set before reloading, cleared on successful boot
// (main.tsx). Still set on the next failure = the reload did not help (outage): don't loop.

const RELOAD_FLAG = "appstrate:chunk-reload";

const CHUNK_ERROR_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || CHUNK_ERROR_RE.test(error.message);
}

/** `false` when the guard already fired or sessionStorage is unusable (no loop guard possible): surface the error. */
export function reloadOnceForChunkError(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG) !== null) return false;
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

export function clearChunkReloadFlag(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    // sessionStorage unusable — nothing to clear.
  }
}
