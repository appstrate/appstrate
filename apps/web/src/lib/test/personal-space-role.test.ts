// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const {
  FOLLOW_ORG_DEFAULT,
  guestRoleValues,
  memberOverrideToSelectValue,
  memberPersonalSpaceRoleRequest,
  orgPersonalSpaceRoleBody,
  storedRoleToSelectValue,
} = await import("../personal-space-role.ts");

describe("memberPersonalSpaceRoleRequest", () => {
  it("clears the override with a bodyless DELETE for « selon l’organisation »", () => {
    expect(memberPersonalSpaceRoleRequest(FOLLOW_ORG_DEFAULT)).toEqual({ method: "DELETE" });
  });

  it("sets a preset with exactly preset_role", () => {
    expect(memberPersonalSpaceRoleRequest("preset:viewer")).toEqual({
      method: "PUT",
      body: { preset_role: "viewer" },
    });
  });

  it("sets a custom role with exactly custom_role_id", () => {
    expect(memberPersonalSpaceRoleRequest("custom:srl_abc")).toEqual({
      method: "PUT",
      body: { custom_role_id: "srl_abc" },
    });
  });
});

describe("select values", () => {
  it("reads a member override back into the select", () => {
    expect(memberOverrideToSelectValue(null)).toBe(FOLLOW_ORG_DEFAULT);
    expect(memberOverrideToSelectValue({ preset_role: "builder" })).toBe("preset:builder");
    expect(memberOverrideToSelectValue({ custom_role_id: "srl_abc" })).toBe("custom:srl_abc");
  });

  it("reads the stored org role", () => {
    expect(storedRoleToSelectValue("runner")).toBe("preset:runner");
    expect(storedRoleToSelectValue("srl_abc")).toBe("custom:srl_abc");
  });

  it("writes the org role as a bare key or id", () => {
    expect(orgPersonalSpaceRoleBody("preset:runner")).toEqual({ personal_space_role: "runner" });
    expect(orgPersonalSpaceRoleBody("custom:srl_abc")).toEqual({ personal_space_role: "srl_abc" });
  });
});

describe("guestRoleValues", () => {
  it("offers a guest only the roles granting nothing beyond operator", () => {
    const role = (kind: "preset" | "custom", key: string, permissions: string[]) => ({
      id: kind === "custom" ? `srl_${key}` : null,
      kind,
      key,
      permissions,
    });
    const values = guestRoleValues([
      role("preset", "admin", ["agents:read", "agents:write"]),
      role("preset", "operator", ["agents:read", "agents:run"]),
      role("preset", "viewer", ["agents:read"]),
      role("custom", "reader", ["agents:read"]),
      role("custom", "author", ["agents:write"]),
    ]);
    expect([...values]).toEqual(["preset:operator", "preset:viewer", "custom:srl_reader"]);
  });
});
