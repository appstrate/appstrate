// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { orgSettingsReadSchema, orgSettingsSchema } from "../src/permissions.ts";

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

  it("refuses a personal_space_role other than admin or operator", () => {
    expect(orgSettingsSchema.partial().safeParse({ personal_space_role: "builder" }).success).toBe(
      false,
    );
  });
});
