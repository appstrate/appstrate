// SPDX-License-Identifier: Apache-2.0

/**
 * A read-only role only rereads its own past sessions, so without any the tab has nothing to do.
 * A preview keeps the previewer's own sessions: the persona is judged on its grants alone.
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
