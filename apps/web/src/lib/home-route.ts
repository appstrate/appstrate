// SPDX-License-Identifier: Apache-2.0

/** What `/` shows: the Studio's dashboard, else the chat, else a refusal, once the grants are known. */
export function homeOf(reach: {
  ready: boolean;
  studio: boolean;
  chat: boolean;
}): "dashboard" | "pending" | "chat" | "denied" {
  if (reach.studio) return "dashboard";
  if (!reach.ready) return "pending";
  return reach.chat ? "chat" : "denied";
}
