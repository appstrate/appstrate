// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, it, expect } from "bun:test";
import { idTokenClaims } from "../../src/sso/auth-plugin.ts";

const jwt = (claims: unknown) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

describe("idTokenClaims", () => {
  it("reads tid and email", () => {
    expect(idTokenClaims(jwt({ tid: "t", email: "a@b.test" }))).toEqual({
      tenantId: "t",
      email: "a@b.test",
    });
  });

  it("reads nothing from a malformed or absent token", () => {
    for (const token of [undefined, "", "abc", "a.!!!.c", jwt({ tid: 42 })]) {
      expect(idTokenClaims(token).tenantId).toBeNull();
    }
  });
});
