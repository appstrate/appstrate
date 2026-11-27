// SPDX-License-Identifier: Apache-2.0

/** What `/` opens: the chat, the Studio's dashboard, a refusal, or nothing yet. */
type Home = "chat" | "dashboard" | "pending" | "denied";

/**
 * The chat first, wherever it is the reader's (`chat`: `undefined` while the space listing that
 * decides it has not answered), else the Studio's dashboard, else a refusal.
 */
export function homeOf(reach: {
  ready: boolean;
  studio: boolean;
  chat: boolean | undefined;
}): Home {
  if (reach.chat) return "chat";
  if (!reach.ready || reach.chat === undefined) return "pending";
  return reach.studio ? "dashboard" : "denied";
}
