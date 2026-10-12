// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { OrgModelInfo } from "../../hooks/use-models.ts";
import { knownModels, planModelChoice } from "../model-choice.ts";
import type { ModelPickRow } from "../model-source.ts";

function row(id: string): ModelPickRow {
  return {
    id,
    label: id,
    contextWindow: null,
    maxTokens: null,
    input: null,
    reasoning: null,
    source: null,
    endpointCapabilities: {},
    cost: null,
    origin: "catalog",
    featured: false,
  };
}

const existing = (modelId: string, isDefault = false, enabled = true) =>
  ({ id: `db_${modelId}`, modelId, is_default: isDefault, enabled }) as OrgModelInfo;

const picked = (...ids: string[]) => new Map(ids.map((id) => [id, row(id)]));

describe("planModelChoice", () => {
  it("creates the ticked models that are not there yet", () => {
    const plan = planModelChoice({
      picked: picked("a", "b"),
      existing: [existing("a")],
      starred: null,
    });
    expect(plan.add.map((r) => r.id)).toEqual(["b"]);
    expect(plan.withdraw).toEqual([]);
  });

  it("withdraws access from the models left unticked, it never deletes them", () => {
    const plan = planModelChoice({
      picked: picked("a"),
      existing: [existing("a"), existing("b")],
      starred: null,
    });
    expect(plan.withdraw.map((m) => m.modelId)).toEqual(["b"]);
    expect(plan.add).toEqual([]);
    expect(plan.grant).toEqual([]);
  });

  it("gives access back to a switched-off model that is ticked again, rather than creating it", () => {
    const plan = planModelChoice({
      picked: picked("a", "b"),
      existing: [existing("a"), existing("b", false, false)],
      starred: null,
    });
    expect(plan.grant.map((m) => m.modelId)).toEqual(["b"]);
    expect(plan.add).toEqual([]);
    expect(plan.withdraw).toEqual([]);
  });

  it("leaves a switched-off model that stays unticked alone", () => {
    const plan = planModelChoice({
      picked: picked("a"),
      existing: [existing("a"), existing("b", false, false)],
      starred: null,
    });
    expect(plan.grant).toEqual([]);
    expect(plan.withdraw).toEqual([]);
  });

  it("changes the default only to a ticked model that is not already it", () => {
    const base = { picked: picked("a", "b"), existing: [existing("a", true), existing("b")] };
    expect(planModelChoice({ ...base, starred: "a" }).defaultModelId).toBeNull();
    expect(planModelChoice({ ...base, starred: "b" }).defaultModelId).toBe("b");
    expect(planModelChoice({ ...base, starred: "c" }).defaultModelId).toBeNull();
    expect(planModelChoice({ ...base, starred: null }).defaultModelId).toBeNull();
  });
});

describe("the retry of a partly refused batch", () => {
  // « Ajouter une clé org »: the dialog was given no models (the key did not exist), the first
  // attempt created `a` and the server refused `b`. The retry asks only for `b`.
  it("creates only what the first attempt did not", () => {
    const created = existing("a");
    const plan = planModelChoice({
      picked: picked("a", "b"),
      existing: knownModels([], [created]),
      starred: null,
    });
    expect(plan.add.map((r) => r.id)).toEqual(["b"]);
    expect(plan.grant).toEqual([]);
    expect(plan.withdraw).toEqual([]);
  });

  it("without the created rows the retry would post `a` again (409 model_already_added)", () => {
    const plan = planModelChoice({ picked: picked("a", "b"), existing: [], starred: null });
    expect(plan.add.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("counts a row once when the dialog's own list has caught up with it", () => {
    const created = existing("a");
    const known = knownModels([created], [{ ...created }]);
    expect(known).toHaveLength(1);
  });

  it("keeps the default the first attempt starred, so it stays locked and is not set twice", () => {
    const created = existing("a", true);
    const plan = planModelChoice({
      picked: picked("a", "b"),
      existing: knownModels([], [created]),
      starred: "a",
    });
    expect(plan.defaultModelId).toBeNull();
  });
});
