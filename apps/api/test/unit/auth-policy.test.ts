// SPDX-License-Identifier: Apache-2.0

// Unit tests for the platform auth-policy helpers and the pure
// `evaluateSignupPolicy` decision function. No DB access — the
// invitation existence is passed in as a boolean.

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import {
  emailDomain,
  evaluateSignupPolicy,
  isAllowedSignupDomain,
  isBootstrapOwner,
  isPlatformAdmin,
  normalizeEmail,
} from "@appstrate/db/auth-policy";

const SNAPSHOT = {
  AUTH_DISABLE_SIGNUP: process.env.AUTH_DISABLE_SIGNUP,
  AUTH_DISABLE_ORG_CREATION: process.env.AUTH_DISABLE_ORG_CREATION,
  AUTH_ALLOWED_SIGNUP_DOMAINS: process.env.AUTH_ALLOWED_SIGNUP_DOMAINS,
  AUTH_PLATFORM_ADMIN_EMAILS: process.env.AUTH_PLATFORM_ADMIN_EMAILS,
  AUTH_BOOTSTRAP_OWNER_EMAIL: process.env.AUTH_BOOTSTRAP_OWNER_EMAIL,
  AUTH_BOOTSTRAP_ORG_NAME: process.env.AUTH_BOOTSTRAP_ORG_NAME,
};

function clearAuthEnv() {
  for (const k of Object.keys(SNAPSHOT)) delete process.env[k];
  _resetCacheForTesting();
}

function restore() {
  for (const [k, v] of Object.entries(SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetCacheForTesting();
}

beforeEach(() => {
  clearAuthEnv();
});

afterAll(() => {
  restore();
});

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
});

describe("emailDomain", () => {
  it("returns the domain part lowercase", () => {
    expect(emailDomain("foo@Bar.COM")).toBe("bar.com");
  });
  it("returns null for malformed input", () => {
    expect(emailDomain("noatsign")).toBeNull();
    expect(emailDomain("@empty-local.com")).toBeNull();
    expect(emailDomain("trailing@")).toBeNull();
  });
});

describe("isPlatformAdmin", () => {
  it("returns false when env is unset / empty", () => {
    expect(isPlatformAdmin("anyone@x.com")).toBe(false);
  });
  it("matches case-insensitively against the allowlist", () => {
    process.env.AUTH_PLATFORM_ADMIN_EMAILS = "Admin@Acme.com, ops@acme.com";
    _resetCacheForTesting();
    expect(isPlatformAdmin("admin@acme.com")).toBe(true);
    expect(isPlatformAdmin("OPS@ACME.COM")).toBe(true);
    expect(isPlatformAdmin("intruder@acme.com")).toBe(false);
  });
});

describe("isAllowedSignupDomain", () => {
  it("returns true when no domain restriction is configured", () => {
    expect(isAllowedSignupDomain("anyone@anywhere.com")).toBe(true);
  });
  it("accepts emails whose domain is on the allowlist", () => {
    process.env.AUTH_ALLOWED_SIGNUP_DOMAINS = "acme.com, foo.io";
    _resetCacheForTesting();
    expect(isAllowedSignupDomain("user@ACME.com")).toBe(true);
    expect(isAllowedSignupDomain("dev@foo.io")).toBe(true);
    expect(isAllowedSignupDomain("intruder@evil.com")).toBe(false);
  });
  it("strips a leading @ from configured domains", () => {
    process.env.AUTH_ALLOWED_SIGNUP_DOMAINS = "@acme.com";
    _resetCacheForTesting();
    expect(isAllowedSignupDomain("user@acme.com")).toBe(true);
  });
  it("rejects malformed emails", () => {
    process.env.AUTH_ALLOWED_SIGNUP_DOMAINS = "acme.com";
    _resetCacheForTesting();
    expect(isAllowedSignupDomain("noatsign")).toBe(false);
  });
});

describe("isBootstrapOwner", () => {
  it("returns false when env is unset", () => {
    expect(isBootstrapOwner("anyone@x.com")).toBe(false);
  });
  it("matches case-insensitively against the configured email", () => {
    process.env.AUTH_BOOTSTRAP_OWNER_EMAIL = "Owner@Acme.com";
    _resetCacheForTesting();
    expect(isBootstrapOwner("OWNER@acme.com")).toBe(true);
    expect(isBootstrapOwner("other@acme.com")).toBe(false);
  });
});

describe("evaluateSignupPolicy — open mode", () => {
  it("allows any email when nothing is configured", () => {
    const decision = evaluateSignupPolicy("anyone@anywhere.com", false);
    expect(decision).toEqual({ allowed: true, reason: "domain_ok" });
  });

  it("rejects emails outside the domain allowlist (even in open mode)", () => {
    process.env.AUTH_ALLOWED_SIGNUP_DOMAINS = "acme.com";
    _resetCacheForTesting();
    const decision = evaluateSignupPolicy("intruder@evil.com", false);
    expect(decision).toEqual({ allowed: false, reason: "signup_domain_not_allowed" });
  });

  it("accepts emails inside the domain allowlist", () => {
    process.env.AUTH_ALLOWED_SIGNUP_DOMAINS = "acme.com";
    _resetCacheForTesting();
    const decision = evaluateSignupPolicy("user@acme.com", false);
    expect(decision).toEqual({ allowed: true, reason: "domain_ok" });
  });
});

describe("evaluateSignupPolicy — closed mode", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLE_SIGNUP = "true";
    _resetCacheForTesting();
  });

  it("rejects unknown signups", () => {
    const decision = evaluateSignupPolicy("stranger@x.com", false);
    expect(decision).toEqual({ allowed: false, reason: "signup_disabled" });
  });

  it("allows signup when a pending invitation exists", () => {
    const decision = evaluateSignupPolicy("invitee@x.com", true);
    expect(decision).toEqual({ allowed: true, reason: "invitation" });
  });

  it("allows signup for platform admins", () => {
    process.env.AUTH_PLATFORM_ADMIN_EMAILS = "admin@acme.com";
    _resetCacheForTesting();
    const decision = evaluateSignupPolicy("Admin@Acme.com", false);
    expect(decision).toEqual({ allowed: true, reason: "platform_admin" });
  });

  it("allows signup for the bootstrap owner", () => {
    process.env.AUTH_BOOTSTRAP_OWNER_EMAIL = "owner@acme.com";
    _resetCacheForTesting();
    const decision = evaluateSignupPolicy("Owner@Acme.com", false);
    expect(decision).toEqual({ allowed: true, reason: "bootstrap" });
  });

  it("bootstrap takes priority over platform admin (deterministic ordering)", () => {
    process.env.AUTH_BOOTSTRAP_OWNER_EMAIL = "owner@acme.com";
    process.env.AUTH_PLATFORM_ADMIN_EMAILS = "owner@acme.com";
    _resetCacheForTesting();
    const decision = evaluateSignupPolicy("owner@acme.com", false);
    expect(decision).toEqual({ allowed: true, reason: "bootstrap" });
  });

  it("rejects emails outside the domain allowlist before checking the closed-mode rule", () => {
    process.env.AUTH_ALLOWED_SIGNUP_DOMAINS = "acme.com";
    _resetCacheForTesting();
    const decision = evaluateSignupPolicy("stranger@evil.com", false);
    expect(decision).toEqual({ allowed: false, reason: "signup_domain_not_allowed" });
  });

  it("invitation override beats the domain allowlist (an invited user from another domain still joins)", () => {
    process.env.AUTH_ALLOWED_SIGNUP_DOMAINS = "acme.com";
    _resetCacheForTesting();
    const decision = evaluateSignupPolicy("contractor@external.io", true);
    expect(decision).toEqual({ allowed: true, reason: "invitation" });
  });
});
