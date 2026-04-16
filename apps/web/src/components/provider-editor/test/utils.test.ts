// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { migrateLegacyFieldName, patchCredentialsInDef } from "../utils";

describe("migrateLegacyFieldName", () => {
  it("returns the same object when no flat field is present", () => {
    const def = { authMode: "api_key", credentials: { fieldName: "api_key" } };
    expect(migrateLegacyFieldName(def)).toBe(def);
  });

  it("lifts flat credentialFieldName into nested credentials.fieldName", () => {
    const out = migrateLegacyFieldName({
      authMode: "api_key",
      credentialFieldName: "api_key",
    });
    expect(out).toEqual({
      authMode: "api_key",
      credentials: { fieldName: "api_key" },
    });
    expect("credentialFieldName" in out).toBe(false);
  });

  it("preserves an existing nested fieldName (canonical wins)", () => {
    const out = migrateLegacyFieldName({
      authMode: "api_key",
      credentialFieldName: "old_key",
      credentials: { fieldName: "new_key", schema: { type: "object" } },
    });
    expect(out.credentials).toEqual({
      fieldName: "new_key",
      schema: { type: "object" },
    });
    expect("credentialFieldName" in out).toBe(false);
  });

  it("drops the flat key without setting nested when flat value is empty", () => {
    const out = migrateLegacyFieldName({
      authMode: "api_key",
      credentialFieldName: "",
    });
    expect("credentialFieldName" in out).toBe(false);
    expect(out.credentials).toBeUndefined();
  });

  it("drops the flat key without setting nested when flat value is undefined", () => {
    const out = migrateLegacyFieldName({
      authMode: "api_key",
      credentialFieldName: undefined,
    });
    expect("credentialFieldName" in out).toBe(false);
    expect(out.credentials).toBeUndefined();
  });

  it("preserves the existing credentials.schema when migrating", () => {
    const schema = {
      type: "object",
      properties: { api_key: { type: "string" } },
    };
    const out = migrateLegacyFieldName({
      authMode: "api_key",
      credentialFieldName: "api_key",
      credentials: { schema },
    });
    expect(out.credentials).toEqual({
      schema,
      fieldName: "api_key",
    });
  });

  it("does not mutate the input definition", () => {
    const input = {
      authMode: "api_key",
      credentialFieldName: "api_key",
      credentials: { schema: { type: "object" } },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    migrateLegacyFieldName(input);
    expect(input).toEqual(snapshot);
  });
});

describe("patchCredentialsInDef", () => {
  it("creates credentials when absent", () => {
    expect(patchCredentialsInDef({ authMode: "api_key" }, { fieldName: "api_key" })).toEqual({
      authMode: "api_key",
      credentials: { fieldName: "api_key" },
    });
  });

  it("merges into existing credentials", () => {
    const out = patchCredentialsInDef(
      { authMode: "api_key", credentials: { schema: { type: "object" } } },
      { fieldName: "api_key" },
    );
    expect(out.credentials).toEqual({
      schema: { type: "object" },
      fieldName: "api_key",
    });
  });

  it("overwrites existing keys in the patch", () => {
    const out = patchCredentialsInDef({ credentials: { fieldName: "old" } }, { fieldName: "new" });
    expect((out.credentials as Record<string, unknown>).fieldName).toBe("new");
  });
});
