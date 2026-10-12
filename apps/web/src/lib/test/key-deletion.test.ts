// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { OrgModelInfo } from "../../hooks/use-models.ts";
import { planKeyDeletion } from "../key-deletion.ts";

function model(id: string, over: Partial<OrgModelInfo> = {}): OrgModelInfo {
  return {
    id,
    label: id,
    modelId: id,
    credentialId: "cred_a",
    enabled: true,
    is_default: false,
    needs_reconnection: false,
    binding: "org",
    source: "custom",
    ...over,
  } as OrgModelInfo;
}

describe("planKeyDeletion", () => {
  it("lists every row of the key, and names the accessible ones", () => {
    const plan = planKeyDeletion(
      [
        model("a1"),
        model("a2", { enabled: false }),
        model("b1", { credentialId: "cred_b" }),
        model("sys", { credentialId: null, source: "built-in", binding: "managed" }),
      ],
      "cred_a",
    );
    expect(plan.doomed.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(plan.accessible.map((m) => m.id)).toEqual(["a1"]);
    expect(plan.defaultModel).toBeNull();
    expect(plan.replacements).toEqual([]);
  });

  it("asks for another default when the key serves it, offering only models that can take over", () => {
    const plan = planKeyDeletion(
      [
        model("a1", { is_default: true }),
        model("a2"),
        model("b1", { credentialId: "cred_b" }),
        model("b2", { credentialId: "cred_b", enabled: false }),
        model("b3", { credentialId: "cred_b", needs_reconnection: true }),
        model("m1", { credentialId: null, binding: "member" }),
        model("sys", { credentialId: null, source: "built-in", binding: "managed" }),
      ],
      "cred_a",
    );
    expect(plan.defaultModel?.id).toBe("a1");
    expect(plan.replacements.map((m) => m.id)).toEqual(["b1", "sys"]);
  });
});
