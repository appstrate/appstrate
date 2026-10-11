// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { OrgModelInfo } from "../../hooks/use-models.ts";
import { planModelChoice } from "../model-choice.ts";
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

const existing = (modelId: string, isDefault = false) =>
  ({ id: `db_${modelId}`, modelId, is_default: isDefault }) as OrgModelInfo;

const picked = (...ids: string[]) => new Map(ids.map((id) => [id, row(id)]));

describe("planModelChoice", () => {
  it("creates the ticked models that are not there yet", () => {
    const plan = planModelChoice({
      picked: picked("a", "b"),
      existing: [existing("a")],
      starred: null,
    });
    expect(plan.add.map((r) => r.id)).toEqual(["b"]);
    expect(plan.remove).toEqual([]);
  });

  it("deletes the models left unticked", () => {
    const plan = planModelChoice({
      picked: picked("a"),
      existing: [existing("a"), existing("b")],
      starred: null,
    });
    expect(plan.remove.map((m) => m.modelId)).toEqual(["b"]);
    expect(plan.add).toEqual([]);
  });

  it("changes the default only to a ticked model that is not already it", () => {
    const base = { picked: picked("a", "b"), existing: [existing("a", true), existing("b")] };
    expect(planModelChoice({ ...base, starred: "a" }).defaultModelId).toBeNull();
    expect(planModelChoice({ ...base, starred: "b" }).defaultModelId).toBe("b");
    expect(planModelChoice({ ...base, starred: "c" }).defaultModelId).toBeNull();
    expect(planModelChoice({ ...base, starred: null }).defaultModelId).toBeNull();
  });
});
