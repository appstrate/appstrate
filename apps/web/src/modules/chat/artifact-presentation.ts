// SPDX-License-Identifier: Apache-2.0

import type { DocumentOpenOptions } from "@appstrate/module-chat/ui";

export interface ArtifactDocument {
  id: string;
  name: string;
}

export interface ArtifactPresentation {
  doc: ArtifactDocument;
  trigger: DocumentOpenOptions["trigger"];
  /** Router entry that owned the request; prevents cross-conversation leakage. */
  navigationKey: string;
}

export interface ArtifactPresentationState {
  current: ArtifactPresentation | null;
  /** A close is sticky for that primary id, but a newer primary may still open. */
  dismissedPrimaryIds: ReadonlySet<string>;
}

export type ArtifactPresentationAction =
  | {
      type: "present";
      presentation: ArtifactPresentation;
      /** False on compact layouts where automatic overlays would steal focus. */
      automaticPresentationAllowed: boolean;
    }
  | { type: "close" }
  | { type: "reset" };

export const INITIAL_ARTIFACT_PRESENTATION_STATE: ArtifactPresentationState = {
  current: null,
  dismissedPrimaryIds: new Set(),
};

/**
 * The complete artefact-presentation policy behind one reducer interface:
 * manual intent wins, a dismissed primary stays dismissed, and a new primary
 * may replace only an automatically presented one.
 */
export function artifactPresentationReducer(
  state: ArtifactPresentationState,
  action: ArtifactPresentationAction,
): ArtifactPresentationState {
  if (action.type === "reset") return INITIAL_ARTIFACT_PRESENTATION_STATE;

  if (action.type === "close") {
    if (!state.current) return state;
    if (state.current.trigger !== "primary") return { ...state, current: null };
    const dismissedPrimaryIds = new Set(state.dismissedPrimaryIds);
    dismissedPrimaryIds.add(state.current.doc.id);
    return { current: null, dismissedPrimaryIds };
  }

  const next = action.presentation;
  if (next.trigger === "primary") {
    if (!action.automaticPresentationAllowed || state.dismissedPrimaryIds.has(next.doc.id)) {
      return state;
    }
    // A direct user choice in the same conversation is authoritative. Primary
    // events from another conversation may replace hidden stale state safely.
    if (state.current?.navigationKey === next.navigationKey && state.current.trigger === "manual") {
      return state;
    }
  }

  return { ...state, current: next };
}

/** Only expose state created by the router entry currently on screen. */
export function visibleArtifact(
  state: ArtifactPresentationState,
  navigationKey: string,
): ArtifactPresentation | null {
  return state.current?.navigationKey === navigationKey ? state.current : null;
}
