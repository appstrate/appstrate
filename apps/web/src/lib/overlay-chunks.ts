// SPDX-License-Identifier: Apache-2.0

/**
 * The code of the overlays the sidebar opens, downloaded before the click.
 *
 * Each overlay is a lazy chunk. Fetched on the click, its Suspense fallback
 * commits first, and React then holds that fallback for its reveal throttle
 * (~300 ms) however fast the chunk arrives: the catalogue measured 330 ms cold
 * for chunks that landed in 10 ms. Settings paid it twice, because the layout
 * had to render before its page's chunk was even requested (620 ms). Already in
 * the module map, nothing suspends and both open in one frame.
 *
 * So each chunk here is the ONE `import()` its route component in `app.tsx`
 * renders through (`lib/lazy-chunk.tsx`, which renders a loaded module without
 * suspending), and the shell preloads them on intent (hover, focus, touch) and
 * once the browser is idle — what `<Link prefetch="intent">` does in React Router's
 * framework mode, which the declarative mode this app uses leaves to the app.
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

/**
 * What opening each overlay renders. A settings scope's index lands on its
 * first page, `general` unless the caller's grants skip it: the layout and that
 * page load together, never one after the other.
 */
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

/** The handlers that preload an overlay link's destination on intent. */
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
