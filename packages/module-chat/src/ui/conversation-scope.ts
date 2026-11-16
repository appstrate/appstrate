// SPDX-License-Identifier: Apache-2.0

/**
 * What the open conversation is anchored to: its origin space and whether it is limited to it.
 * Published by `Conversation` to everything below it (the composer's limit item and chip, the
 * enforced-skills read, the skills picker, the tool cards), which would otherwise each re-derive
 * it from the host's selected space — the one thing that does NOT define an existing conversation.
 */

import { createContext, useContext, type ReactNode } from "react";
import { useChatHost, useChatTransport, type ChatTranslate } from "./runtime-context.ts";

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

/** Why a file cannot be attached, when it cannot: where the chat does not act, or off a limited origin. */
export type AttachUnavailable = "outside" | "limited";

/**
 * Whether the composer may stage a file. An upload lands in the working space: the host says
 * whether the chat acts there (`hostCanAttach`), and a LIMITED conversation reaches its origin
 * space alone, so it takes a file only while the working space IS that origin.
 */
export function attachAvailability(
  hostCanAttach: boolean,
  scope: Pick<ConversationScope, "originSpaceId" | "restricted">,
  workingSpaceId: string | null | undefined,
): { available: true } | { available: false; reason: AttachUnavailable } {
  const origin = pinnedSpaceOf(scope);
  if (origin !== undefined && workingSpaceId !== origin) {
    return { available: false, reason: "limited" };
  }
  return hostCanAttach ? { available: true } : { available: false, reason: "outside" };
}

/** {@link attachAvailability} of the open conversation, in the host's working space. */
export function useAttachAvailability(): ReturnType<typeof attachAvailability> {
  const { canAttach = true } = useChatHost();
  const scope = useConversationScope();
  return attachAvailability(canAttach, scope, useChatTransport()?.spaceId);
}

const noLabels = () => undefined;
const useNoLabels = () => noLabels;

/** The plain name of the space `spaceId`, when the host names spaces (for accessible names). */
export function useSpaceLabel(spaceId: string | null | undefined): string | undefined {
  const { useSpaceLabelOf = useNoLabels } = useChatHost();
  return useSpaceLabelOf()(spaceId);
}

/**
 * The conversation's origin space as the host renders it (tile and name); without the host's
 * rendering or an origin, the generic « this space ». Never a plain string for an accessible name:
 * use {@link useSpaceLabel} for those.
 */
export function useOriginSpaceNode(): ReactNode {
  const { t, renderSpaces } = useChatHost();
  const { originSpaceId } = useConversationScope();
  return originSpaceId && renderSpaces
    ? renderSpaces([originSpaceId])
    : t("composer.limit.thisSpace");
}

/** The origin space as the pinned endpoint sees it: set only while the conversation is limited. */
export function pinnedSpaceOf(
  scope: Pick<ConversationScope, "originSpaceId" | "restricted">,
): string | undefined {
  return scope.restricted && scope.originSpaceId ? scope.originSpaceId : undefined;
}

/**
 * The space a tool call acted in: the one the engine stamped on the call when it dispatched it
 * (`providerMetadata.appstrate.spaceId`: the origin of a limited conversation, the named
 * `space_id` otherwise). Read from the call itself, never from the conversation's present limit,
 * which can change after the call was made. `undefined` for a call that acts in no space.
 */
export function callSpaceOf(part: { providerMetadata?: unknown }): string | undefined {
  const stamp = (part.providerMetadata as { appstrate?: { spaceId?: unknown } } | undefined)
    ?.appstrate?.spaceId;
  return typeof stamp === "string" && stamp ? stamp : undefined;
}

/**
 * The accessible names of the limit item and of the chip's remove button: the sentence with the
 * space's plain name, since the visible name is a node (tile and text) that a label would drop.
 */
export function limitAccessibleNames(
  t: ChatTranslate,
  spaceName: string,
): { item: string; undo: string } {
  return {
    item: t("composer.limit", { name: spaceName }),
    undo: t("composer.limit.undo", { name: spaceName }),
  };
}
