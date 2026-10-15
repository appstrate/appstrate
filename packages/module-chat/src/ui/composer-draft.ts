// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a composer takes the draft handed to a new conversation. It is taken
 * once per conversation: the thread mounts a composer on its welcome screen and
 * another in its footer once a message is sent, and the footer's must not put
 * back the draft the first send consumed. Nor does a draft replace typed text.
 */
export function takesDraft(
  draft: string | undefined,
  state: { seeded: boolean; typed: string },
): draft is string {
  return !state.seeded && !!draft && state.typed === "";
}
