// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  orgSettingsReadSchema,
  orgSettingsSchema,
  orgSettingsWireSchema,
  personalSpaceRoleSettingSchema,
} from "../src/permissions.ts";

describe("orgSettingsReadSchema", () => {
  it("defaults personal_model_credentials to true", () => {
    expect(orgSettingsReadSchema.parse({}).personal_model_credentials).toBe(true);
  });

  it("keeps an explicit false", () => {
    expect(orgSettingsReadSchema.parse({ personal_model_credentials: false })).toMatchObject({
      personal_model_credentials: false,
    });
  });

  it("defaults personal_space_role to admin and keeps an explicit operator", () => {
    expect(orgSettingsReadSchema.parse({}).personal_space_role).toBe("admin");
    expect(orgSettingsReadSchema.parse({ personal_space_role: "operator" })).toMatchObject({
      personal_space_role: "operator",
    });
  });

  it("keeps unknown keys", () => {
    expect(orgSettingsReadSchema.parse({ future_key: 1 })).toMatchObject({ future_key: 1 });
  });
});

describe("orgSettingsSchema", () => {
  it("does not default personal_model_credentials on a partial parse", () => {
    const parsed = orgSettingsSchema.partial().parse({});
    expect("personal_model_credentials" in parsed).toBe(false);
    expect("personal_space_role" in parsed).toBe(false);
  });

  // The stored key holds a preset only: a custom default lives in
  // `organizations.personal_space_role_id`, under an FK.
  it("stores a preset key as personal_space_role, never a custom role id", () => {
    const parse = (value: unknown) =>
      orgSettingsSchema.partial().safeParse({ personal_space_role: value }).success;
    for (const preset of ["admin", "builder", "operator", "runner", "viewer"]) {
      expect(parse(preset), preset).toBe(true);
    }
    expect(parse("srl_11111111-1111-4111-8111-111111111111")).toBe(false);
  });

  it("refuses any other personal_space_role", () => {
    const parse = (value: unknown) =>
      orgSettingsSchema.partial().safeParse({ personal_space_role: value }).success;
    for (const value of ["owner", "superuser", "srl_nope", 1, null]) {
      expect(parse(value), String(value)).toBe(false);
    }
  });
});

describe("personalSpaceRoleSettingSchema (the wire value)", () => {
  it("accepts a preset key or a custom role id, and nothing else", () => {
    const ok = (value: unknown) => personalSpaceRoleSettingSchema.safeParse(value).success;
    for (const preset of ["admin", "builder", "operator", "runner", "viewer"]) {
      expect(ok(preset), preset).toBe(true);
    }
    expect(ok("srl_11111111-1111-4111-8111-111111111111")).toBe(true);
    for (const value of [
      "owner",
      "srl_nope",
      "SRL_11111111-1111-4111-8111-111111111111",
      1,
      null,
    ]) {
      expect(ok(value), String(value)).toBe(false);
    }
  });

  it("orgSettingsWireSchema serves a custom id, orgSettingsReadSchema does not read one", () => {
    const id = "srl_11111111-1111-4111-8111-111111111111";
    expect(orgSettingsWireSchema.parse({ personal_space_role: id }).personal_space_role).toBe(id);
    expect(orgSettingsWireSchema.parse({}).personal_space_role).toBe("admin");
    expect(orgSettingsReadSchema.safeParse({ personal_space_role: id }).success).toBe(false);
  });
});
