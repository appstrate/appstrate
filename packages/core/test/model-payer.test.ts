// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  orgSettingsReadSchema,
  orgSettingsSchema,
  orgSettingsWireSchema,
  spaceRoleReferenceSchema,
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

  it("does not store personal_space_role: it is projected from the organizations columns", () => {
    expect("personal_space_role" in orgSettingsSchema.shape).toBe(false);
  });
});

describe("spaceRoleReferenceSchema (the wire value)", () => {
  it("accepts one role reference, and nothing else", () => {
    const ok = (value: unknown) => spaceRoleReferenceSchema.safeParse(value).success;
    for (const preset of ["admin", "builder", "operator", "runner", "viewer"]) {
      expect(ok({ preset_role: preset }), preset).toBe(true);
    }
    expect(ok({ custom_role_id: "srl_11111111-1111-4111-8111-111111111111" })).toBe(true);
    for (const value of [
      "admin",
      "srl_11111111-1111-4111-8111-111111111111",
      { preset_role: "owner" },
      { custom_role_id: "srl_nope" },
      { custom_role_id: "SRL_11111111-1111-4111-8111-111111111111" },
      { preset_role: "viewer", custom_role_id: "srl_11111111-1111-4111-8111-111111111111" },
      {},
      1,
      null,
    ]) {
      expect(ok(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("orgSettingsWireSchema serves a role reference", () => {
    const id = "srl_11111111-1111-4111-8111-111111111111";
    expect(
      orgSettingsWireSchema.parse({ personal_space_role: { custom_role_id: id } })
        .personal_space_role,
    ).toEqual({ custom_role_id: id });
    expect(orgSettingsWireSchema.parse({}).personal_space_role).toEqual({ preset_role: "admin" });
    expect(orgSettingsWireSchema.safeParse({ personal_space_role: id }).success).toBe(false);
  });
});
