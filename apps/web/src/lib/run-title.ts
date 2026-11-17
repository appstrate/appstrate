// SPDX-License-Identifier: Apache-2.0

/** `agentName` is the snapshot of the inline manifest's `display_name`; the caller localizes the fallback. */
export function inlineRunDisplayName(
  agentName: string | null | undefined,
  fallback: string,
): string {
  return agentName?.trim() || fallback;
}

/** Inline agents are 1:1 with their run, so their name is the page title; cataloged ones keep the numbered title. */
export function runPageTitle(params: {
  isInline: boolean;
  inlineName: string;
  numberedTitle: string;
}): string {
  return params.isInline ? params.inlineName : params.numberedTitle;
}
