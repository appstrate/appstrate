// SPDX-License-Identifier: Apache-2.0

/**
 * What the open conversation is anchored to: its origin space and whether it is limited to it.
 * Published by `Conversation` to everything below it (the composer's limit item and chip, the
 * enforced-skills read, the skills picker, the tool cards), which would otherwise each re-derive
 * it from the host's selected space — the one thing that does NOT define an existing conversation.
 */

import { createContext, useContext } from "react";

export interface ConversationScope {
  /**
   * The conversation's origin space: the stored one for an existing conversation, the selected
   * space (when the chat acts there) for one not yet started. `null`: none (« Vue d'ensemble »).
   */
  originSpaceId: string | null;
  /** Limited to the origin space: its tools take no `space_id` and act there alone. */
  restricted: boolean;
  /** Limit (`true`) or lift (`false`): local until the first message, a PATCH afterwards. */
  setRestricted: (next: boolean) => void;
}

const NO_SCOPE: ConversationScope = {
  originSpaceId: null,
  restricted: false,
  setRestricted: () => {},
};

const ConversationScopeContext = createContext<ConversationScope>(NO_SCOPE);

export const ConversationScopeProvider = ConversationScopeContext.Provider;

export function useConversationScope(): ConversationScope {
  return useContext(ConversationScopeContext);
}

/** Why the limit cannot be turned on, when it cannot. */
export type LimitUnavailable = "no-space" | "outside";

/**
 * Whether « Limiter à cet espace » can be turned on: there is an origin space and the chat acts in
 * it. A conversation already limited can always be released, whatever the acting set became.
 */
export function limitAvailability(
  scope: Pick<ConversationScope, "originSpaceId" | "restricted">,
  actingSpaceIds: readonly string[],
): { available: true } | { available: false; reason: LimitUnavailable } {
  if (scope.restricted) return { available: true };
  if (!scope.originSpaceId) return { available: false, reason: "no-space" };
  if (!actingSpaceIds.includes(scope.originSpaceId)) return { available: false, reason: "outside" };
  return { available: true };
}

/** The origin space as the pinned endpoint sees it: set only while the conversation is limited. */
export function pinnedSpaceOf(
  scope: Pick<ConversationScope, "originSpaceId" | "restricted">,
): string | undefined {
  return scope.restricted && scope.originSpaceId ? scope.originSpaceId : undefined;
}

/**
 * The space a tool call acted in: the one it named (`space_id`), else the origin space of a
 * limited conversation — its calls go through the pinned endpoint and carry none.
 */
export function callSpace(
  named: string | undefined,
  scope: Pick<ConversationScope, "originSpaceId" | "restricted">,
): string | undefined {
  return named ?? pinnedSpaceOf(scope);
}
