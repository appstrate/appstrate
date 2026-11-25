// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, it, expect } from "bun:test";
import {
  emailDomainOf,
  newVerificationToken,
  normalizeDomain,
  verificationRecordName,
  verificationRecordValue,
} from "../../src/sso/domain.ts";

describe("normalizeDomain", () => {
  it("lowercases and drops a trailing dot", () => {
    expect(normalizeDomain(" Corp.Example.COM. ")).toBe("corp.example.com");
  });

  it("refuses what is not a public hostname", () => {
    for (const value of [
      "",
      "localhost",
      "a@b.com",
      "10.0.0.1",
      "-a.com",
      "a-.com",
      "a..com",
      "a_b.com",
      `${"a".repeat(64)}.com`,
    ]) {
      expect(normalizeDomain(value)).toBeNull();
    }
  });
});

describe("emailDomainOf", () => {
  it("reads the domain of an address, and nothing from a non-address", () => {
    expect(emailDomainOf("Alice@Corp.Test")).toBe("corp.test");
    expect(emailDomainOf("eu.corp.test")).toBeNull();
    expect(emailDomainOf("@corp.test")).toBeNull();
  });

  it("does not fold a subdomain into its parent", () => {
    expect(emailDomainOf("bob@eu.corp.test")).toBe("eu.corp.test");
  });
});

describe("verification record", () => {
  it("names the record and its value", () => {
    expect(verificationRecordName("corp.test")).toBe("_appstrate.corp.test");
    expect(verificationRecordValue("abc")).toBe("appstrate-domain-verification=abc");
  });

  it("mints 128-bit tokens that do not repeat", () => {
    const a = newVerificationToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newVerificationToken()).not.toBe(a);
  });
});
