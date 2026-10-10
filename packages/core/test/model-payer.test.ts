// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { MODEL_PAYERS } from "../src/model-payer.ts";
import { orgSettingsReadSchema, orgSettingsSchema } from "../src/permissions.ts";

describe("MODEL_PAYERS", () => {
  it("lists the payers in pg enum label order", () => {
    expect([...MODEL_PAYERS]).toEqual(["system", "org", "user"]);
  });
});

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
  });
});
