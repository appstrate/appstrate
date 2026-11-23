// SPDX-License-Identifier: Apache-2.0

/**
 * What the open conversation is anchored to: its origin space and whether it is limited to it,
 * published by `Conversation` to the composer, the skills picker and the tool cards.
 */

import { createContext, useContext, type ReactNode } from "react";
import { actsIn, useChatHost, type ChatHost } from "./runtime-context.ts";

export interface ConversationScope {
  /**
   * The conversation's origin space: the stored one for an existing conversation, the selected
   * space (when the chat acts there) for one not yet started. `null`: none (« Tous les espaces »).
   */
  originSpaceId: string | null;
  /** Limited to the origin space: its tools take no `space_id` and act there alone. */
  restricted: boolean;
  /** A turn is generating: the limit cannot change until it ends. */
  generating: boolean;
  /** A change of the limit is in flight: a second one would roll back to the first's value. */
  pending: boolean;
  /**
   * Limit to `spaceId`: the origin, or the space a conversation without one takes as its origin.
   * Local until the first message, a PATCH afterwards.
   */
  limitTo: (spaceId: string) => void;
  /** Lift the limit, keeping the origin; before the first message, a chosen space is dropped. */
  lift: () => void;
}

const NO_SCOPE: ConversationScope = {
  originSpaceId: null,
  restricted: false,
  generating: false,
  pending: false,
  limitTo: () => {},
  lift: () => {},
};

const ConversationScopeContext = createContext<ConversationScope>(NO_SCOPE);

export const ConversationScopeProvider = ConversationScopeContext.Provider;

export function useConversationScope(): ConversationScope {
  return useContext(ConversationScopeContext);
}

/** The composer's space-level permissions follow the same acting space as the turn. */
export function conversationTurnCan(
  scope: Pick<ConversationScope, "restricted" | "originSpaceId">,
  host: Pick<ChatHost, "actingSpaceIds" | "can" | "canIn">,
) {
  if (!scope.restricted) return host.can;
  const origin = scope.originSpaceId;
  return (permission: string) =>
    !!origin && actsIn(host.actingSpaceIds, origin) && host.canIn(origin, permission);
}

export function useConversationTurnCan() {
  return conversationTurnCan(useConversationScope(), useChatHost());
}

/** Why the limit cannot change: a turn generates, the chat acts nowhere, or not in the origin. */
export type LimitUnavailableReason = "generating" | "no-acting-space" | "outside";

/**
 * How the limit can change. `toggle`: one click, naming `spaceId` (the origin, or the one space
 * the chat acts in for a conversation without an origin); `choose`: a conversation without an
 * origin picks it among `spaceIds`, the spaces the chat acts in; `unavailable`, with the reason,
 * `null` while the acting set is not known.
 */
type LimitAvailability =
  | { kind: "toggle"; spaceId: string }
  | { kind: "choose"; spaceIds: readonly string[] }
  | { kind: "unavailable"; reason: LimitUnavailableReason | null };

/** The one decision on « Limiter à… »: a limited conversation can always be released. */
export function limitAvailability(
  scope: Pick<ConversationScope, "originSpaceId" | "restricted" | "generating">,
  actingSpaceIds: readonly string[] | null,
): LimitAvailability {
  if (scope.generating) return { kind: "unavailable", reason: "generating" };
  const origin = scope.originSpaceId;
  if (origin && scope.restricted) return { kind: "toggle", spaceId: origin };
  if (actingSpaceIds === null) return { kind: "unavailable", reason: null };
  if (origin) {
    return actsIn(actingSpaceIds, origin)
      ? { kind: "toggle", spaceId: origin }
      : { kind: "unavailable", reason: "outside" };
  }
  if (actingSpaceIds.length === 0) return { kind: "unavailable", reason: "no-acting-space" };
  if (actingSpaceIds.length === 1) return { kind: "toggle", spaceId: actingSpaceIds[0]! };
  return { kind: "choose", spaceIds: actingSpaceIds };
}

/**
 * `spaceId` as the host names it: the plain `label` for accessible names, the `node` (tile and
 * name) for what is shown. `undefined` when there is none or the host cannot name it: the caller
 * then says the generic sentence.
 */
export function useSpaceName(
  spaceId: string | null,
): { label: string; node: ReactNode } | undefined {
  const { renderSpaces, useSpaceLabelOf } = useChatHost();
  const label = useSpaceLabelOf()(spaceId);
  return spaceId && label ? { label, node: renderSpaces([spaceId]) } : undefined;
}

/** The origin space a limited conversation acts in alone: set only while it is limited. */
export function limitedSpaceOf(
  scope: Pick<ConversationScope, "originSpaceId" | "restricted">,
): string | undefined {
  return scope.restricted && scope.originSpaceId ? scope.originSpaceId : undefined;
}

/**
 * The space a tool call acted in, as the engine stamped it on the call
 * (`providerMetadata.appstrate.spaceId`): read from the call, never from the conversation's present
 * limit, which can change afterwards. `undefined` for a call that acts in no space.
 */
export function callSpaceOf(part: { providerMetadata?: unknown }): string | undefined {
  const stamp = (part.providerMetadata as { appstrate?: { spaceId?: unknown } } | undefined)
    ?.appstrate?.spaceId;
  return typeof stamp === "string" && stamp ? stamp : undefined;
}
