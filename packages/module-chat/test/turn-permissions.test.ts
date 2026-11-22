// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { turnPermissions, turnUsesDrafts } from "../src/turn-permissions.ts";

const GRANTED = [
  "mcp:read",
  "skills:read",
  "skills:write",
  "skills:delete",
  "agents:read",
  "agents:write",
];

describe("turnPermissions", () => {
  it("keeps every `skills:*` while skill discovery is on", () => {
    const out = turnPermissions(GRANTED, { authoring: true, skillDiscovery: true });
    expect(out).toEqual(GRANTED);
  });

  it("drops every `skills:*`, and nothing else, when discovery is off", () => {
    const out = turnPermissions(GRANTED, { authoring: true, skillDiscovery: false });
    expect(out).toEqual(["mcp:read", "agents:read", "agents:write"]);
  });

  it("narrows by the authoring switch independently of discovery", () => {
    const out = turnPermissions(GRANTED, { authoring: false, skillDiscovery: true });
    expect(out).not.toContain("skills:write");
    expect(out).not.toContain("agents:write");
    expect(out).toContain("skills:read");
  });
});

describe("turnUsesDrafts", () => {
  it("holds with authoring on and `skills:write`, and only then", () => {
    const writer = new Set(GRANTED);
    const reader = new Set(GRANTED.filter((permission) => permission !== "skills:write"));
    expect(turnUsesDrafts(writer, { authoring: true })).toBe(true);
    expect(turnUsesDrafts(writer, { authoring: false })).toBe(false);
    expect(turnUsesDrafts(reader, { authoring: true })).toBe(false);
  });
});
