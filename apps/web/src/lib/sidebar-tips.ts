// SPDX-License-Identifier: Apache-2.0

import { catalogueHref } from "./catalogue-link";
import { isUnder } from "./route-access";

/**
 * The getting-started cards of the sidebar's foot, in the order a new organization meets them:
 * connect a service, create an agent from the chat, invite colleagues, schedule an agent, then
 * the catalogue, which stays while nothing else is left. A new organization already holds an
 * example agent, so the chat's card asks for a first conversation, not for a first agent.
 */
const SIDEBAR_TIPS = ["connect", "chat", "invite", "schedule", "catalogue"] as const;

export type SidebarTipId = (typeof SIDEBAR_TIPS)[number];

/** Where each card's button leads. */
export const SIDEBAR_TIP_TARGET: Record<SidebarTipId, string> = {
  connect: "/integrations",
  chat: "/chat",
  invite: "/org-settings/members",
  schedule: "/schedules",
  catalogue: catalogueHref("agent"),
};

/** The pages a card says nothing new on: the one its button opens, or a whole overlay of it. */
const SIDEBAR_TIP_PAGE: Record<SidebarTipId, string> = {
  connect: "/integrations",
  chat: "/chat",
  invite: "/org-settings/members",
  schedule: "/schedules",
  catalogue: "/catalogue",
};

/**
 * What the cards are decided on. A count is `undefined` while it is read (or not read at all):
 * a card waiting on one is not drawn, so none appears then vanishes as its data lands.
 */
export interface SidebarTipFacts {
  /** The caller's own connections in the organization. */
  connections: number | undefined;
  /** The person's chat conversations, a page of at most one: whether there is any. */
  conversations: number | undefined;
  /** The agents of the working space; `undefined` too in « Tous les espaces ». */
  agents: number | undefined;
  /** The schedules of the working space; `undefined` too in « Tous les espaces ». */
  schedules: number | undefined;
  /** The organization's members and its pending invitations, together. */
  people: number | undefined;
  canConnect: boolean;
  canCreateWithChat: boolean;
  canInvite: boolean;
  canSchedule: boolean;
  canBrowseCatalogue: boolean;
}

/** Whether a card still has something to teach, from what it is decided on alone. */
const RELEVANT: Record<SidebarTipId, (facts: SidebarTipFacts) => boolean> = {
  connect: (f) => f.canConnect && f.connections === 0,
  chat: (f) => f.canCreateWithChat && f.conversations === 0,
  invite: (f) => f.canInvite && f.people === 1,
  schedule: (f) => f.canSchedule && f.agents !== undefined && f.agents > 0 && f.schedules === 0,
  catalogue: (f) => f.canBrowseCatalogue,
};

/**
 * The cards to draw, in {@link SIDEBAR_TIPS} order: relevant, not dismissed, and not leading to
 * the page already on screen (`here`: the page's path, or the open overlay's).
 */
export function sidebarTips(
  facts: SidebarTipFacts,
  dismissed: readonly string[],
  here: readonly string[],
): SidebarTipId[] {
  return SIDEBAR_TIPS.filter(
    (id) =>
      !dismissed.includes(id) &&
      RELEVANT[id](facts) &&
      !here.some((path) => isUnder(path, SIDEBAR_TIP_PAGE[id])),
  );
}

/** A dismissed list as stored: card ids only, anything else dropped. */
export function parseDismissedTips(value: unknown): SidebarTipId[] {
  if (!Array.isArray(value)) return [];
  return SIDEBAR_TIPS.filter((id) => value.includes(id));
}
