// SPDX-License-Identifier: Apache-2.0

/**
 * What the open conversation is anchored to: its origin space and whether it is limited to it.
 * Published by `Conversation` to everything below it (the composer's limit item and chip, the
 * enforced-skills read, the skills picker, the tool cards), which would otherwise each re-derive
 * it from the host's selected space — the one thing that does NOT define an existing conversation.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { actsIn, useChatHost } from "./runtime-context.ts";
import { useLatest } from "./use-latest.ts";

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

/** Why the limit cannot change: a turn generates, the chat acts nowhere, or not in the origin. */
export type LimitUnavailableReason = "generating" | "no-acting-space" | "outside";

/**
 * How the limit can change. `toggle`: one click, naming `spaceId` (the origin, or the one space
 * the chat acts in for a conversation without an origin); `choose`: a conversation without an
 * origin picks it among `spaceIds`, the spaces the chat acts in; `unavailable`, with the reason,
 * `null` while the acting set is not known.
 */
export type LimitAvailability =
  | { kind: "toggle"; spaceId: string }
  | { kind: "choose"; spaceIds: readonly string[] }
  | { kind: "unavailable"; reason: LimitUnavailableReason | null };

/**
 * The one decision on « Limiter à… ». Not while a turn generates (the server refuses). A limited
 * conversation can always be released, whatever the acting set became. One with an origin limits
 * to it while the chat acts there. One without takes the space it is limited to as its origin.
 */
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
 * Why no file can be attached: the selected space is not one the chat acts in, the limited
 * conversation's origin no longer is, or the chat acts nowhere.
 */
export type AttachUnavailableReason = "outside" | "origin-outside" | "no-acting-space";

/**
 * Where a file goes. `attach`: uploaded into `spaceId` at once; `choose`: the user picks it among
 * `spaceIds`, the spaces the chat acts in; `unavailable`, with the reason, `null` while the acting
 * set is not known.
 */
export type AttachAvailability =
  | { kind: "attach"; spaceId: string }
  | { kind: "choose"; spaceIds: readonly string[] }
  | { kind: "unavailable"; reason: AttachUnavailableReason | null };

/**
 * The one decision on the space a file is uploaded into, which the conversation then touches.
 * The origin while the chat acts there; a limited conversation takes files only there. Without
 * one, the space the host has selected (`selectedSpaceId`) when the chat acts there; in
 * « Tous les espaces » (`null`), the one acting space, else the user picks. Never the host's
 * working space unseen.
 */
export function attachAvailability(
  scope: Pick<ConversationScope, "originSpaceId" | "restricted">,
  actingSpaceIds: readonly string[] | null,
  selectedSpaceId: string | null,
): AttachAvailability {
  if (actingSpaceIds === null) return { kind: "unavailable", reason: null };
  const origin = scope.originSpaceId;
  if (origin && actsIn(actingSpaceIds, origin)) return { kind: "attach", spaceId: origin };
  if (origin && scope.restricted) return { kind: "unavailable", reason: "origin-outside" };
  if (selectedSpaceId !== null) {
    return actsIn(actingSpaceIds, selectedSpaceId)
      ? { kind: "attach", spaceId: selectedSpaceId }
      : { kind: "unavailable", reason: "outside" };
  }
  if (actingSpaceIds.length === 0) return { kind: "unavailable", reason: "no-acting-space" };
  if (actingSpaceIds.length === 1) return { kind: "attach", spaceId: actingSpaceIds[0]! };
  return { kind: "choose", spaceIds: actingSpaceIds };
}

/**
 * The open conversation's {@link attachAvailability}, with the space last picked for it: a
 * dropped file, which cannot ask, goes there while the choice stands.
 */
export interface AttachTarget {
  availability: AttachAvailability;
  /** The space last picked in a `choose`; it counts only while it is one of the choices. */
  picked: string | null;
  /** Picks the space the next files go to. */
  pick: (spaceId: string) => void;
}

/** Where a file added now is uploaded: the decided space, else the one picked; none otherwise. */
export function attachSpaceOf(
  target: Pick<AttachTarget, "availability" | "picked">,
): string | null {
  const { availability } = target;
  if (availability.kind === "attach") return availability.spaceId;
  const { picked } = target;
  return availability.kind === "choose" && picked && availability.spaceIds.includes(picked)
    ? picked
    : null;
}

const NO_ATTACH_TARGET: AttachTarget = {
  availability: { kind: "unavailable", reason: null },
  picked: null,
  pick: () => {},
};

const AttachTargetContext = createContext<AttachTarget>(NO_ATTACH_TARGET);

export const AttachTargetProvider = AttachTargetContext.Provider;

export function useAttachTarget(): AttachTarget {
  return useContext(AttachTargetContext);
}

/**
 * The open conversation's {@link AttachTarget}, under the space the host shows (`selectedSpaceId`,
 * `null` in « Tous les espaces »), and a getter of the space a file added now goes to, read by the
 * attachment adapter. A pick answers the choice offered under the space shown when it was made:
 * showing another drops it.
 */
export function useConversationAttachTarget(
  scope: Pick<ConversationScope, "originSpaceId" | "restricted">,
  selectedSpaceId: string | null,
): { target: AttachTarget; getSpaceId: () => string | null } {
  const { actingSpaceIds } = useChatHost();
  const [last, setLast] = useState<{ spaceId: string; under: string | null } | null>(null);
  const picked = last && last.under === selectedSpaceId ? last.spaceId : null;
  const { originSpaceId, restricted } = scope;
  const availability = useMemo(
    () => attachAvailability({ originSpaceId, restricted }, actingSpaceIds, selectedSpaceId),
    [originSpaceId, restricted, actingSpaceIds, selectedSpaceId],
  );
  const pick = useCallback(
    (spaceId: string) => setLast({ spaceId, under: selectedSpaceId }),
    [selectedSpaceId],
  );
  const target = useMemo(() => ({ availability, picked, pick }), [availability, picked, pick]);
  const getTarget = useLatest(target);
  const getSpaceId = useCallback(() => attachSpaceOf(getTarget()), [getTarget]);
  return { target, getSpaceId };
}

/**
 * The plain name of `spaceId`, for accessible names (the node below carries a tile a label would
 * drop); the generic « this space » when the host does not name it.
 */
export function useSpaceLabel(spaceId: string | null): string {
  const { t, useSpaceLabelOf } = useChatHost();
  return useSpaceLabelOf()(spaceId) ?? t("composer.limit.thisSpace");
}

/**
 * `spaceId` as the host renders it (tile and name); without one, the generic « this space ».
 * Never a plain string for an accessible name: use {@link useSpaceLabel} for those.
 */
export function useSpaceNode(spaceId: string | null): ReactNode {
  const { t, renderSpaces } = useChatHost();
  return spaceId ? renderSpaces([spaceId]) : t("composer.limit.thisSpace");
}

/** {@link useSpaceLabel} of the conversation's origin space. */
export function useOriginSpaceLabel(): string {
  return useSpaceLabel(useConversationScope().originSpaceId);
}

/** {@link useSpaceNode} of the conversation's origin space. */
export function useOriginSpaceNode(): ReactNode {
  return useSpaceNode(useConversationScope().originSpaceId);
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
