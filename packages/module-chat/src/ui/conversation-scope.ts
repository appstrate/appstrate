// SPDX-License-Identifier: Apache-2.0

/**
 * What the open conversation is anchored to: its origin space and whether it is limited to it,
 * published by `Conversation` to the composer, the skills picker and the tool cards.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { actsIn, useChatHost } from "./runtime-context.ts";

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
 * The one decision on the space a file is uploaded into. Never the host's working space unseen:
 * in « Tous les espaces » (`selectedSpaceId` `null`) without an origin, the user picks.
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

/** The open conversation's {@link attachAvailability} and the space a file goes to now. */
interface AttachTarget {
  availability: AttachAvailability;
  /** The decided space, else the one picked while it is one of the choices; `null` for none. */
  spaceId: string | null;
  /** Picks the space the next files go to. */
  pick: (spaceId: string) => void;
  /** Drops the pick: the turn it was made for is sent. */
  forget: () => void;
}

/** Where a file goes now: the decided space, else the one picked while it is a choice. */
export function attachSpaceOf(
  availability: AttachAvailability,
  picked: string | null,
): string | null {
  if (availability.kind === "attach") return availability.spaceId;
  return availability.kind === "choose" && picked && availability.spaceIds.includes(picked)
    ? picked
    : null;
}

const NO_ATTACH_TARGET: AttachTarget = {
  availability: { kind: "unavailable", reason: null },
  spaceId: null,
  pick: () => {},
  forget: () => {},
};

const AttachTargetContext = createContext<AttachTarget>(NO_ATTACH_TARGET);

export const AttachTargetProvider = AttachTargetContext.Provider;

export function useAttachTarget(): AttachTarget {
  return useContext(AttachTargetContext);
}

/**
 * The open conversation's {@link AttachTarget} under the space the host shows (`selectedSpaceId`,
 * `null` in « Tous les espaces »). A pick answers the choice offered when it was made: a target
 * that is no longer that choice drops it, and so does sending the turn (`forget`).
 */
export function useConversationAttachTarget(
  scope: Pick<ConversationScope, "originSpaceId" | "restricted">,
  selectedSpaceId: string | null,
): AttachTarget {
  const { actingSpaceIds } = useChatHost();
  const [picked, pick] = useState<string | null>(null);
  const { originSpaceId, restricted } = scope;
  const availability = useMemo(
    () => attachAvailability({ originSpaceId, restricted }, actingSpaceIds, selectedSpaceId),
    [originSpaceId, restricted, actingSpaceIds, selectedSpaceId],
  );
  const spaceId = attachSpaceOf(availability, picked);
  if (picked && (availability.kind !== "choose" || spaceId === null)) pick(null);
  const forget = useCallback(() => pick(null), []);
  return useMemo(() => ({ availability, spaceId, pick, forget }), [availability, spaceId, forget]);
}

/**
 * The spaces a turn sent now reads, where its attachments must be: a limited conversation's
 * origin alone (while the chat acts there), else the acting set. `null` while that is not known.
 */
export function turnSpacesOf(
  scope: Pick<ConversationScope, "originSpaceId" | "restricted">,
  actingSpaceIds: readonly string[] | null,
): readonly string[] | null {
  if (actingSpaceIds === null) return null;
  const limited = limitedSpaceOf(scope);
  if (limited === undefined) return actingSpaceIds;
  return actsIn(actingSpaceIds, limited) ? [limited] : [];
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
