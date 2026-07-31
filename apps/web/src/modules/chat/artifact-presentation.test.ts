// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  INITIAL_ARTIFACT_PRESENTATION_STATE,
  artifactPresentationReducer,
  visibleArtifact,
  type ArtifactPresentation,
  type ArtifactPresentationState,
} from "./artifact-presentation";

const request = (
  id: string,
  trigger: "manual" | "primary",
  navigationKey = "chat-a",
): ArtifactPresentation => ({
  doc: { id, name: `${id}.md` },
  trigger,
  navigationKey,
});

const present = (
  state: ArtifactPresentationState,
  presentation: ArtifactPresentation,
  automaticPresentationAllowed = true,
) =>
  artifactPresentationReducer(state, {
    type: "present",
    presentation,
    automaticPresentationAllowed,
  });

describe("artifact presentation policy", () => {
  it("opens a live primary only when the layout can show it beside the chat", () => {
    expect(present(INITIAL_ARTIFACT_PRESENTATION_STATE, request("doc-a", "primary"), false)).toBe(
      INITIAL_ARTIFACT_PRESENTATION_STATE,
    );
    expect(
      present(INITIAL_ARTIFACT_PRESENTATION_STATE, request("doc-a", "primary")).current?.doc.id,
    ).toBe("doc-a");
  });

  it("lets manual selection win over later primary publications", () => {
    const manual = present(INITIAL_ARTIFACT_PRESENTATION_STATE, request("manual", "manual"));
    expect(present(manual, request("primary", "primary"))).toBe(manual);
  });

  it("allows a newer primary to replace an automatically presented primary", () => {
    const first = present(INITIAL_ARTIFACT_PRESENTATION_STATE, request("doc-a", "primary"));
    expect(present(first, request("doc-b", "primary")).current?.doc.id).toBe("doc-b");
  });

  it("does not reopen a dismissed primary but still opens a newer one", () => {
    const open = present(INITIAL_ARTIFACT_PRESENTATION_STATE, request("doc-a", "primary"));
    const closed = artifactPresentationReducer(open, { type: "close" });
    expect(closed.current).toBeNull();
    expect(present(closed, request("doc-a", "primary"))).toBe(closed);
    expect(present(closed, request("doc-b", "primary")).current?.doc.id).toBe("doc-b");
  });

  it("never exposes an artefact from another navigation entry", () => {
    const state = present(INITIAL_ARTIFACT_PRESENTATION_STATE, request("doc-a", "manual"));
    expect(visibleArtifact(state, "chat-a")?.doc.id).toBe("doc-a");
    expect(visibleArtifact(state, "chat-b")).toBeNull();
  });
});
