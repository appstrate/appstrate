// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the human label carried by an inline run. `agent_name` is the
 * denormalized snapshot of the inline manifest's `display_name`; the fallback
 * is localized by the caller.
 */
export function inlineRunDisplayName(
  agentName: string | null | undefined,
  fallback: string,
): string {
  return agentName?.trim() || fallback;
}

/**
 * Inline agents are one-shot and 1:1 with their run, so their task-specific
 * display name is the page title. Cataloged agents keep the conventional
 * numbered run title.
 */
export function runPageTitle(params: {
  isInline: boolean;
  inlineName: string;
  numberedTitle: string;
}): string {
  return params.isInline ? params.inlineName : params.numberedTitle;
}
