// SPDX-License-Identifier: Apache-2.0

/**
 * Liveness gate in `pickModel`.
 *
 * `GET /api/models` used to DROP a model whose credential can no longer serve
 * inference; it now LISTS it carrying `needs_reconnection: true` (the row has to
 * stay visible for the user to reconnect or delete it, and its credential is
 * undeletable while the row references it). The chat therefore has to do the
 * filtering itself — otherwise a default that went dead after being chosen is
 * picked and the turn fails deep inside the provider with an opaque error.
 */

import { describe, expect, it } from "bun:test";
import { pickModel, type OrgModel } from "../src/llm.ts";

function model(id: string, over: Partial<OrgModel> = {}): OrgModel {
  return { id, modelId: `upstream-${id}`, apiShape: "openai-completions", ...over };
}

describe("pickModel liveness", () => {
  it("skips a dead model when resolving the org default", () => {
    const dead = model("preset_dead", { is_default: true, needs_reconnection: true });
    const live = model("preset_live");
    expect(pickModel([dead, live]).id).toBe("preset_live");
  });

  it("treats an absent flag as live", () => {
    // `needs_reconnection` is snake_case on the wire and absent on older rows —
    // the gate must be `=== true`, never truthiness on a camelCase typo.
    expect(pickModel([model("preset_1", { is_default: true })]).id).toBe("preset_1");
  });

  it("still honours an explicit id", () => {
    const chosen = pickModel(
      [model("preset_default", { is_default: true }), model("preset_pinned")],
      "preset_pinned",
    );
    expect(chosen.id).toBe("preset_pinned");
  });

  it("refuses an explicitly pinned dead model with the reconnection message", () => {
    // Not "is not an enabled model" — the model exists and is enabled; only its
    // credential is gone, and that is the fix to name.
    expect(() =>
      pickModel([model("preset_dead", { needs_reconnection: true })], "preset_dead"),
    ).toThrow(/reconnexion|rétablie/i);
  });

  it("fails clearly when every model is dead", () => {
    // The user HAS a chat-usable model, so the family fallback ("configure a
    // model") would send them chasing the wrong fix.
    expect(() =>
      pickModel([
        model("preset_a", { is_default: true, needs_reconnection: true }),
        model("preset_b", { needs_reconnection: true }),
      ]),
    ).toThrow(/rétablie/i);
  });

  it("keeps the family fallback for a configured but unusable family", () => {
    // Unchanged path: nothing chat-usable at all is a different diagnosis.
    expect(() => pickModel([model("preset_1", { apiShape: "google-generative-ai" })])).toThrow(
      /Aucun modèle utilisable/,
    );
  });
});
