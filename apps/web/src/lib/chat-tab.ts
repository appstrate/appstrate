// SPDX-License-Identifier: Apache-2.0

/**
 * Conversations are each person's own. A role that may read but not write the
 * chat (a viewer) only ever rereads what it wrote before: without any, the tab
 * would lead to a page with nothing to do. A preview restricts the caller
 * without replacing them, so the sessions it finds are the previewer's own: the
 * persona is judged on its grants alone.
 */
export function isChatTabShown(input: {
  reachable: boolean;
  canWrite: boolean;
  previewing: boolean;
  hasOwnSessions: boolean | undefined;
}): boolean {
  return (
    input.reachable && (input.canWrite || (!input.previewing && input.hasOwnSessions === true))
  );
}
