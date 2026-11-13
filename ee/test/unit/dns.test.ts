// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, it, expect } from "bun:test";
import { hasVerificationRecord, type TxtResolver } from "../../src/sso/dns.ts";

const fail =
  (code: string): TxtResolver =>
  async () => {
    throw Object.assign(new Error(code), { code });
  };

describe("hasVerificationRecord", () => {
  it("reads _appstrate.<domain> and matches the exact value", async () => {
    let asked = "";
    const resolve: TxtResolver = async (name) => {
      asked = name;
      return [["v=spf1 -all"], ["appstrate-domain-verification=tok"]];
    };
    expect(await hasVerificationRecord("corp.test", "tok", resolve)).toBe(true);
    expect(asked).toBe("_appstrate.corp.test");
    expect(await hasVerificationRecord("corp.test", "other", resolve)).toBe(false);
  });

  it("joins a record split into several character-strings", async () => {
    const resolve: TxtResolver = async () => [["appstrate-domain-", "verification=tok"]];
    expect(await hasVerificationRecord("corp.test", "tok", resolve)).toBe(true);
  });

  it("reads 'no such record' as absent, and any other failure as a failure", async () => {
    for (const code of ["ENOTFOUND", "ENODATA"]) {
      expect(await hasVerificationRecord("corp.test", "tok", fail(code))).toBe(false);
    }
    await expect(hasVerificationRecord("corp.test", "tok", fail("ETIMEOUT"))).rejects.toThrow();
  });
});
