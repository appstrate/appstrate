// SPDX-License-Identifier: Apache-2.0

/**
 * Overlay code downloaded before the click: fetched on the click, a lazy chunk's
 * Suspense fallback is held for React's reveal throttle (~300 ms). Each chunk is the
 * ONE `import()` its route in `app.tsx` renders through (`lib/lazy-chunk.tsx`).
 */

import { warmChunk } from "./chunk-warmup";
import { chunk, type Chunk } from "./lazy-chunk";
import { isUnder, SETTINGS_INDEX } from "./route-access";

export const catalogueChunk = chunk(() => import("../pages/catalogue"));
export const settingsLayoutChunk = chunk(() => import("../pages/settings/layout"));
export const orgSettingsGeneralChunk = chunk(() => import("../pages/org-settings/general"));
export const workspaceSettingsGeneralChunk = chunk(
  () => import("../pages/workspace-settings/general"),
);
export const preferencesGeneralChunk = chunk(() => import("../pages/preferences/general"));

/** What opening each overlay renders: a settings scope's layout and its first page (`general`) load together. */
const OVERLAY_CHUNKS: ReadonlyArray<readonly [prefix: string, chunks: Chunk<unknown>[]]> = [
  ["/catalogue", [catalogueChunk]],
  [SETTINGS_INDEX.organization, [settingsLayoutChunk, orgSettingsGeneralChunk]],
  [SETTINGS_INDEX.workspace, [settingsLayoutChunk, workspaceSettingsGeneralChunk]],
  [SETTINGS_INDEX.account, [settingsLayoutChunk, preferencesGeneralChunk]],
];

/** Downloads the chunks the overlay at `path` renders; a path that opens none is a no-op. */
function preloadOverlay(path: string): void {
  const pathname = path.split(/[?#]/, 1)[0]!;
  for (const [prefix, chunks] of OVERLAY_CHUNKS) {
    if (isUnder(pathname, prefix)) for (const { load } of chunks) warmChunk(load);
  }
}

export function overlayIntent(path: string) {
  const preload = () => preloadOverlay(path);
  return { onPointerEnter: preload, onFocus: preload, onTouchStart: preload };
}

/**
 * Preloads `paths` once the browser is idle. Returns the cancel, for an effect.
 * `requestIdleCallback` is missing from some Safari versions: a timeout stands in.
 */
export function preloadOverlaysWhenIdle(paths: readonly string[]): () => void {
  const run = () => paths.forEach(preloadOverlay);
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 3000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 1000);
  return () => window.clearTimeout(id);
}
