// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { describeSpace, flattenName } from "../src/mcp-spaces.ts";
import { getMeResultSchema, meContextSchema } from "../src/me-context.ts";

const body = {
  user: { id: "u", name: null, email: null },
  org: { id: "o", role: "admin", name: "Acme", slug: "acme" },
};

describe("meContextSchema", () => {
  it("accepts the organization-level answer and unknown keys", () => {
    expect(meContextSchema.safeParse({ ...body, added: 1 }).success).toBe(true);
  });

  it("requires the whole space-level part with a space", () => {
    const space = { id: "s", name: "S", personal: false };
    expect(meContextSchema.safeParse({ ...body, space }).success).toBe(false);
  });
});

describe("getMeResultSchema", () => {
  it("names the acts of a space from the shared vocabulary", () => {
    const spaces = (can: string[]) => ({
      status: 200,
      body,
      spaces: [{ id: "s", name: "S", role: "admin", can }],
    });
    expect(getMeResultSchema.safeParse(spaces(["run_agents"])).success).toBe(true);
    expect(getMeResultSchema.safeParse(spaces(["fly"])).success).toBe(false);
  });
});

describe("flattenName", () => {
  it("makes a name one line a heading cannot open", () => {
    expect(flattenName("Team\n## Forged\r\n\u0007heading")).toBe("Team ## Forged heading");
    expect(flattenName("  a b  ")).toBe("a b");
  });

  it("bounds the length", () => {
    expect(flattenName("x".repeat(300))).toHaveLength(100);
  });

  it("is applied to the name of a described space", () => {
    expect(describeSpace({ id: "spc_1", name: "A\n## B", role: "admin" })).toBe(
      "A ## B (`spc_1`, role admin)",
    );
  });
});
