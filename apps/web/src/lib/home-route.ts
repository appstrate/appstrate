// SPDX-License-Identifier: Apache-2.0

/** What `/` opens: the chat, the Studio's dashboard, a refusal, or nothing yet. */
type Home = "chat" | "dashboard" | "pending" | "denied";

/**
 * The chat first, wherever it is the reader's (`chat`: `undefined` until the grants and the
 * space listing have answered), else the Studio's dashboard, else a refusal.
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

/** The product whose frame `/` draws: the chat's while it leads there or may still, wherever the instance loads it. */
export function homeProduct(home: Home, chatLoaded: boolean): "chat" | "studio" {
  return home === "chat" || (home === "pending" && chatLoaded) ? "chat" : "studio";
}
