// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { toolSnapshot } from "../integration-tool-snapshot.ts";

const CONNECTION = "11111111-1111-4111-8111-111111111111";
const detail = (overrides: Partial<Parameters<typeof toolSnapshot>[0]> = {}) => ({
  active: true,
  tool_snapshot: null,
  auths: [],
  ...overrides,
});

describe("toolSnapshot", () => {
  it("offers the listing of a Streamable HTTP remote server only", () => {
    expect(toolSnapshot(detail(), "available", true)).toBeDefined();
    expect(toolSnapshot(detail(), "sse", true)).toBeUndefined();
    expect(toolSnapshot(detail(), null, true)).toBeUndefined();
  });

  it("names the connection the server was listed with, and whether the integration is OAuth", () => {
    const snapshot = toolSnapshot(
      detail({
        tool_snapshot: {
          connection_id: CONNECTION,
          listed_at: "2026-11-20T10:00:00.000Z",
          truncated: false,
          added: 0,
          missing: 0,
          modified: 0,
        },
        auths: [{ type: "oauth2", connections: [{ id: CONNECTION, label: "Compte de Léa" }] }],
      }),
      "available",
      true,
    );
    expect(snapshot?.connectionLabel).toBe("Compte de Léa");
    expect(snapshot?.oauth).toBe(true);
    expect(toolSnapshot(detail(), "available", true)?.connectionLabel).toBeNull();
  });

  it("names the first reason the refresh would be refused", () => {
    const block = (
      published: boolean,
      active: boolean,
      availability: "available" | "no_connection",
    ) => toolSnapshot(detail({ active }), availability, published)?.refreshBlock;
    expect(block(true, true, "available")).toBeNull();
    expect(block(false, false, "available")).toBe("unpublished");
    expect(block(true, false, "available")).toBe("inactive");
    expect(block(true, true, "no_connection")).toBe("no_connection");
  });
});
