// SPDX-License-Identifier: Apache-2.0

/**
 * What the open conversation is anchored to: its origin space and whether it is limited to it.
 * Published by `Conversation` to everything below it (the composer's limit item and chip, the
 * enforced-skills read, the skills picker, the tool cards), which would otherwise each re-derive
 * it from the host's selected space — the one thing that does NOT define an existing conversation.
 */

import { createContext, useContext, type ReactNode } from "react";
import { actsIn, useChatHost } from "./runtime-context.ts";

export interface ConversationScope {
  /**
   * The conversation's origin space: the stored one for an existing conversation, the selected
   * space (when the chat acts there) for one not yet started. `null`: none (« Vue d'ensemble »).
   */
  originSpaceId: string | null;
  /** Limited to the origin space: its tools take no `space_id` and act there alone. */
  restricted: boolean;
  /** A turn is generating: the limit cannot change until it ends. */
  generating: boolean;
  /** A change of the limit is in flight: a second one would roll back to the first's value. */
  pending: boolean;
  /** Limit (`true`) or lift (`false`): local until the first message, a PATCH afterwards. */
  setRestricted: (next: boolean) => void;
}

const NO_SCOPE: ConversationScope = {
  originSpaceId: null,
  restricted: false,
  generating: false,
  pending: false,
  setRestricted: () => {},
};

const ConversationScopeContext = createContext<ConversationScope>(NO_SCOPE);

export const ConversationScopeProvider = ConversationScopeContext.Provider;

export function useConversationScope(): ConversationScope {
  return useContext(ConversationScopeContext);
}

/**
 * Whether « Limiter à cet espace » can change: not while a turn generates (the server refuses),
 * else there is an origin space and the chat acts in it (`outside` also when the host's working
 * space is one the chat does not act in, so no origin was taken). A conversation already limited can always
 * be released, whatever the acting set became.
 */
export function limitAvailability(
  scope: Pick<ConversationScope, "originSpaceId" | "restricted" | "generating">,
  actingSpaceIds: readonly string[],
  workingSpaceId?: string | null,
): { available: true } | { available: false; reason: "generating" | "no-space" | "outside" } {
  if (scope.generating) return { available: false, reason: "generating" };
  if (scope.restricted) return { available: true };
  if (!scope.originSpaceId) {
    // No origin: « Vue d'ensemble », or a working space the chat does not act in (the origin is
    // only ever a space it acts in).
    const outside = !!workingSpaceId && !actsIn(actingSpaceIds, workingSpaceId);
    return { available: false, reason: outside ? "outside" : "no-space" };
  }
  if (!actsIn(actingSpaceIds, scope.originSpaceId)) return { available: false, reason: "outside" };
  return { available: true };
}

/**
 * Whether the composer may stage a file. An upload lands in the working space, which the turn
 * resolves only where the chat acts; and a LIMITED conversation reaches its origin space alone, so
 * it takes a file only while the working space IS that origin.
 */
export function attachAvailability(
  actingSpaceIds: readonly string[],
  scope: Pick<ConversationScope, "originSpaceId" | "restricted">,
  workingSpaceId: string | null | undefined,
): { available: true } | { available: false; reason: "outside" | "limited" } {
  const origin = limitedSpaceOf(scope);
  if (origin !== undefined && workingSpaceId !== origin) {
    return { available: false, reason: "limited" };
  }
  return actsIn(actingSpaceIds, workingSpaceId)
    ? { available: true }
    : { available: false, reason: "outside" };
}

/** {@link attachAvailability} of the open conversation, in the host's working space. */
export function useAttachAvailability(): ReturnType<typeof attachAvailability> {
  const { actingSpaceIds, workingSpaceId } = useChatHost();
  return attachAvailability(actingSpaceIds, useConversationScope(), workingSpaceId);
}

const noLabels = () => undefined;
const useNoLabels = () => noLabels;

/**
 * The plain name of the conversation's origin space, for accessible names (the node below carries
 * a tile a label would drop); the generic « this space » when the host does not name it.
 */
export function useOriginSpaceLabel(): string {
  const { t, useSpaceLabelOf = useNoLabels } = useChatHost();
  const { originSpaceId } = useConversationScope();
  return useSpaceLabelOf()(originSpaceId) ?? t("composer.limit.thisSpace");
}

/**
 * The conversation's origin space as the host renders it (tile and name); without the host's
 * rendering or an origin, the generic « this space ». Never a plain string for an accessible name:
 * use {@link useOriginSpaceLabel} for those.
 */
export function useOriginSpaceNode(): ReactNode {
  const { t, renderSpaces } = useChatHost();
  const { originSpaceId } = useConversationScope();
  return originSpaceId && renderSpaces
    ? renderSpaces([originSpaceId])
    : t("composer.limit.thisSpace");
}

/** The origin space a limited conversation acts in alone: set only while it is limited. */
export function limitedSpaceOf(
  scope: Pick<ConversationScope, "originSpaceId" | "restricted">,
): string | undefined {
  return scope.restricted && scope.originSpaceId ? scope.originSpaceId : undefined;
}

/**
 * The space a tool call acted in: the one the engine stamped on the call when it dispatched it
 * (`providerMetadata.appstrate.spaceId`, which the AI SDK stores as `callProviderMetadata` and
 * the runtime hands the card as `providerMetadata`: the origin of a limited conversation, the
 * named `space_id` otherwise). The engine stamps every call that acts in a space. Read from the
 * call itself, never from the conversation's present limit, which can change after the call was
 * made. `undefined` for a call that acts in no space.
 */
export function callSpaceOf(part: { providerMetadata?: unknown }): string | undefined {
  const stamp = (part.providerMetadata as { appstrate?: { spaceId?: unknown } } | undefined)
    ?.appstrate?.spaceId;
  return typeof stamp === "string" && stamp ? stamp : undefined;
}
