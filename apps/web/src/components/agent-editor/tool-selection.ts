// SPDX-License-Identifier: Apache-2.0

/** Pure tool-selection transforms for the integration picker, kept DOM-free for unit tests. */

import { apiUploadToolNameFor } from "@appstrate/core/integration";

/**
 * What « Tout sélectionner » may add: the tools whose checkbox is enabled (a missing, pending or
 * blocked tool is not callable), plus the ones already selected, which stay toggleable.
 */
export function selectableNativeToolNames(
  catalog: readonly { name: string; status?: "available" | "missing" | "pending" | "blocked" }[],
  selected: ReadonlySet<string>,
): string[] {
  return catalog
    .filter(
      (tool) => tool.status === undefined || tool.status === "available" || selected.has(tool.name),
    )
    .map((tool) => tool.name);
}

/** Stale names are dropped on purpose: a bulk action must not keep capabilities the catalog can no longer show. */
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
 * Toggles an api_call tool and its `api_upload` companion as one unit, mirroring the spawn resolver
 * (which grants both from either name). The companion joins only when it is in the visible synthetic
 * set — never write a native or hidden tool merely because it shares the `api_upload` name.
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
  // A hand-edited half-selection counts as ON, so the next click revokes the whole capability.
  if (pair.some((name) => selection.includes(name))) {
    return selection.filter((t) => !pair.includes(t));
  }
  return [...selection, ...pair.filter((t) => !selection.includes(t))];
}
