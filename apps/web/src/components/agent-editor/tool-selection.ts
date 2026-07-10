// SPDX-License-Identifier: Apache-2.0

/**
 * Pure tool-selection transforms for the agent editor's integration picker.
 *
 * Kept out of the component (and out of `@appstrate/core`, which is published
 * and has no business carrying editor-state helpers) so the rules can be
 * unit-tested without a DOM.
 */

import { apiUploadToolNameFor } from "@appstrate/core/integration";

/**
 * Replace the native-tool slice while preserving only currently visible
 * synthetic selections. Unknown/stale names are deliberately dropped: a bulk
 * action must not keep capabilities the current catalog can no longer show or
 * revoke.
 */
export function replaceNativeToolSelection(
  selection: readonly string[],
  nativeToolNames: readonly string[],
  visibleSyntheticToolNames: ReadonlySet<string>,
  selectAll: boolean,
): string[] {
  const preserved = selection.filter((name) => visibleSyntheticToolNames.has(name));
  return selectAll ? [...preserved, ...nativeToolNames] : preserved;
}

/** True when the api_call row's effective capability is currently granted. */
export function isApiCallToolSelectionEnabled(
  selection: ReadonlySet<string>,
  apiCallToolName: string,
  syntheticUploadToolNames: ReadonlySet<string>,
): boolean {
  if (selection.has(apiCallToolName)) return true;
  const companion = apiUploadToolNameFor(apiCallToolName);
  return syntheticUploadToolNames.has(companion) && selection.has(companion);
}

/**
 * Add or remove an api_call tool AND its `api_upload` companion as one unit,
 * returning the next tool selection. The companion joins the move only when the
 * visible synthetic companion set contains it (the auth declared
 * `upload_protocols` and `hidden_tools` did not remove it) — never write a
 * native or hidden tool merely because it shares the `api_upload` name.
 *
 * The pairing mirrors the spawn resolver, which grants both from either name:
 * upload chunks are dispatched through the sibling api_call tool, so a
 * half-selection is either a broken tool or a capability the manifest hides.
 * Order is preserved and the result is duplicate-free.
 */
export function toggleApiCallToolSelection(
  selection: readonly string[],
  apiCallToolName: string,
  syntheticUploadToolNames: ReadonlySet<string>,
): string[] {
  const companion = apiUploadToolNameFor(apiCallToolName);
  const pair = syntheticUploadToolNames.has(companion)
    ? [apiCallToolName, companion]
    : [apiCallToolName];
  // The runtime grants the pair from either member. Treat legacy/hand-edited
  // half-selections as ON as well, so the checkbox reflects effective access
  // and its next click reliably revokes the whole capability.
  if (pair.some((name) => selection.includes(name))) {
    return selection.filter((t) => !pair.includes(t));
  }
  return [...selection, ...pair.filter((t) => !selection.includes(t))];
}
