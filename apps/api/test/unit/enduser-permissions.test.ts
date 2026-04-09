// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { resolveEndUserPermissions } from "../../src/lib/permissions.ts";

describe("resolveEndUserPermissions", () => {
  it("admin can read agents, run, manage connections, manage end-users", () => {
    const perms = resolveEndUserPermissions("admin");
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("agents:run")).toBe(true);
    expect(perms.has("runs:read")).toBe(true);
    expect(perms.has("runs:cancel")).toBe(true);
    expect(perms.has("connections:read")).toBe(true);
    expect(perms.has("connections:connect")).toBe(true);
    expect(perms.has("connections:disconnect")).toBe(true);
    expect(perms.has("schedules:read")).toBe(true);
    expect(perms.has("end-users:read")).toBe(true);
    expect(perms.has("end-users:write")).toBe(true);
  });

  it("admin cannot access org-management resources", () => {
    const perms: Set<string> = resolveEndUserPermissions("admin");
    expect(perms.has("org:read")).toBe(false);
    expect(perms.has("members:read")).toBe(false);
    expect(perms.has("agents:write")).toBe(false);
    expect(perms.has("billing:read")).toBe(false);
    expect(perms.has("models:read")).toBe(false);
    expect(perms.has("webhooks:read")).toBe(false);
    expect(perms.has("api-keys:read")).toBe(false);
  });

  it("member can read agents, run, manage connections", () => {
    const perms = resolveEndUserPermissions("member");
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("agents:run")).toBe(true);
    expect(perms.has("connections:connect")).toBe(true);
    expect(perms.has("end-users:read")).toBe(false);
    expect(perms.has("end-users:write")).toBe(false);
  });

  it("viewer can only read agents and runs", () => {
    const perms = resolveEndUserPermissions("viewer");
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("runs:read")).toBe(true);
    expect(perms.has("agents:run")).toBe(false);
    expect(perms.has("connections:read")).toBe(false);
    expect(perms.size).toBe(2);
  });

  it("returns a new Set each time (no shared state)", () => {
    const a = resolveEndUserPermissions("member");
    const b = resolveEndUserPermissions("member");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
