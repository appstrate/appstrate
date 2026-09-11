// SPDX-License-Identifier: Apache-2.0

/**
 * `useServedModels`' cache, as the three transitions the picker depends on.
 *
 * The web runner has no DOM and no `renderHook`, so what is pinned here is the
 * pure half the hook is built from — the half that carried all three bugs: a
 * refusal that was indistinguishable from an empty listing, a one-slot cache
 * that answered "still asking" forever on A → B → A, and no way to ask again.
 */

import { describe, it, expect } from "bun:test";
import {
  forgetServedModels,
  servedModelsState,
  type ServedModelsCache,
} from "../use-served-models.ts";

const CACHE: ServedModelsCache = {
  cred_a: ["claude-sonnet-4-5-20250929"],
  cred_b: "failed",
};

describe("servedModelsState", () => {
  it("reports a listing, and that nothing is left to ask", () => {
    expect(servedModelsState(CACHE, "cred_a")).toEqual({
      modelIds: ["claude-sonnet-4-5-20250929"],
      failed: false,
      known: true,
    });
  });

  it("tells a refusal apart from a plan that serves nothing", () => {
    // Both answer `modelIds: null`; only `failed` says whether retrying is the
    // thing to offer, or whether the connection genuinely lists no model.
    expect(servedModelsState(CACHE, "cred_b")).toEqual({
      modelIds: null,
      failed: true,
      known: true,
    });
    expect(servedModelsState({ cred_c: [] }, "cred_c")).toEqual({
      modelIds: [],
      failed: false,
      known: true,
    });
  });

  it("marks an unasked credential as still to ask", () => {
    expect(servedModelsState(CACHE, "cred_new")).toEqual({
      modelIds: null,
      failed: false,
      known: false,
    });
  });

  it("asks nothing when no credential is selected", () => {
    expect(servedModelsState(CACHE, null)).toEqual({
      modelIds: null,
      failed: false,
      known: false,
    });
  });

  it("answers the first credential again after switching away and back", () => {
    // A → B → A: the answer is keyed by id, so returning to A reads A's
    // listing instead of a slot that now names B and a spinner nobody fills.
    const seen = ["cred_a", "cred_b", "cred_a"].map((id) => servedModelsState(CACHE, id));
    expect(seen[0]).toEqual(seen[2]);
    expect(seen[2]!.modelIds).toEqual(["claude-sonnet-4-5-20250929"]);
  });
});

describe("forgetServedModels", () => {
  it("drops one answer, which is what makes the effect ask again", () => {
    const next = forgetServedModels(CACHE, "cred_b");
    expect(servedModelsState(next, "cred_b").known).toBe(false);
    expect(servedModelsState(next, "cred_b").failed).toBe(false);
  });

  it("leaves every other credential's answer alone", () => {
    expect(forgetServedModels(CACHE, "cred_b")).toEqual({
      cred_a: ["claude-sonnet-4-5-20250929"],
    });
  });

  it("is a no-op for a credential nothing was ever asked about", () => {
    expect(forgetServedModels(CACHE, "cred_new")).toEqual(CACHE);
  });
});
