// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { patchCredentialsInDef } from "../utils";

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
