// SPDX-License-Identifier: Apache-2.0

// One-shot full-page reload to recover from stale-chunk failures. Route
// chunks are content-hashed, so after a redeploy an already-open tab 404s on
// the old hashes; React caches the rejected `lazy()` payload, which makes the
// failure unrecoverable from inside the app — only a hard reload (fetching
// the fresh index.html and chunk graph) fixes it.
//
// Loop guard: a sessionStorage flag is set right before reloading and cleared
// once the app boots successfully (see main.tsx). If the flag is still set
// when another chunk failure arrives, the previous reload did NOT fix the
// problem (e.g. genuine network outage, server down) — we refuse to reload
// again and let the error surface normally instead of reload-looping the tab.

const RELOAD_FLAG = "appstrate:chunk-reload";

const CHUNK_ERROR_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

/** True when the error is a failed dynamic-import (stale hashed chunk). */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || CHUNK_ERROR_RE.test(error.message);
}

/**
 * Trigger the one-shot reload. Returns `true` when the reload was initiated
 * (caller should render nothing and wait), `false` when the guard already
 * fired this session — or sessionStorage is unusable, in which case we can't
 * guard against a loop so we never auto-reload — and the caller should
 * surface the error normally.
 */
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

/** Clear the loop guard after a successful boot (reload fixed the chunks). */
export function clearChunkReloadFlag(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    // sessionStorage unusable — nothing to clear.
  }
}
