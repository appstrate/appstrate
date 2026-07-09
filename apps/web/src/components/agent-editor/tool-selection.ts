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
 * Add or remove an api_call tool AND its `api_upload` companion as one unit,
 * returning the next tool selection. The companion joins the move only when the
 * resolved catalog actually contains it (i.e. the auth declared
 * `upload_protocols`) — never write a tool the runtime won't serve.
 *
 * The pairing mirrors the spawn resolver, which grants both from either name:
 * upload chunks are dispatched through the sibling api_call tool, so a
 * half-selection is either a broken tool or a capability the manifest hides.
 * Order is preserved and the result is duplicate-free.
 */
export function toggleApiCallToolSelection(
  selection: readonly string[],
  apiCallToolName: string,
  catalogToolNames: readonly string[],
): string[] {
  const companion = apiUploadToolNameFor(apiCallToolName);
  const pair = catalogToolNames.includes(companion)
    ? [apiCallToolName, companion]
    : [apiCallToolName];
  if (selection.includes(apiCallToolName)) {
    return selection.filter((t) => !pair.includes(t));
  }
  return [...selection, ...pair.filter((t) => !selection.includes(t))];
}
