// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { getEnv, _resetCacheForTesting } from "@appstrate/env";

// The test preload set NODE_ENV + APP_URL to dev-friendly values.
// Snapshot everything we touch so other test files are unaffected.
const SNAPSHOT = {
  NODE_ENV: process.env.NODE_ENV,
  APP_URL: process.env.APP_URL,
  TRUST_PROXY: process.env.TRUST_PROXY,
};

function restore() {
  for (const [k, v] of Object.entries(SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetCacheForTesting();
}

beforeEach(() => {
  _resetCacheForTesting();
});

afterAll(() => {
  restore();
});

describe("env schema — production HTTPS invariant (H1)", () => {
  it("NODE_ENV=production + APP_URL=https://... → OK", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_URL = "https://prod.example.com";
    _resetCacheForTesting();
    const env = getEnv();
    expect(env.NODE_ENV).toBe("production");
    expect(env.APP_URL).toBe("https://prod.example.com");
    restore();
  });

  it("NODE_ENV=production + APP_URL=http://... → throws on APP_URL", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_URL = "http://prod.example.com";
    _resetCacheForTesting();
    expect(() => getEnv()).toThrow(/APP_URL.*https/i);
    restore();
  });

  it("NODE_ENV=development + APP_URL=http://localhost → OK (tier 0)", () => {
    process.env.NODE_ENV = "development";
    process.env.APP_URL = "http://localhost:3000";
    _resetCacheForTesting();
    const env = getEnv();
    expect(env.APP_URL).toBe("http://localhost:3000");
    restore();
  });

  it("defaults NODE_ENV to development when unset", () => {
    delete process.env.NODE_ENV;
    process.env.APP_URL = "http://localhost:3000";
    _resetCacheForTesting();
    const env = getEnv();
    expect(env.NODE_ENV).toBe("development");
    restore();
  });
});

describe("env schema — TRUST_PROXY (C1)", () => {
  it("defaults to 'false'", () => {
    delete process.env.TRUST_PROXY;
    _resetCacheForTesting();
    expect(getEnv().TRUST_PROXY).toBe("false");
    restore();
  });

  it("accepts 'true'", () => {
    process.env.TRUST_PROXY = "true";
    _resetCacheForTesting();
    expect(getEnv().TRUST_PROXY).toBe("true");
    restore();
  });

  it("accepts integer strings", () => {
    process.env.TRUST_PROXY = "2";
    _resetCacheForTesting();
    expect(getEnv().TRUST_PROXY).toBe("2");
    restore();
  });

  it("rejects arbitrary strings", () => {
    process.env.TRUST_PROXY = "banana";
    _resetCacheForTesting();
    expect(() => getEnv()).toThrow(/TRUST_PROXY/);
    restore();
  });

  it("rejects negative integers", () => {
    process.env.TRUST_PROXY = "-1";
    _resetCacheForTesting();
    expect(() => getEnv()).toThrow(/TRUST_PROXY/);
    restore();
  });
});

describe("env schema — AUTH_* lockdown vars (issue #228)", () => {
  // Snapshot the AUTH_* vars so each test starts clean and other suites
  // don't inherit the bad values we deliberately install here.
  const AUTH_SNAPSHOT = {
    AUTH_BOOTSTRAP_OWNER_EMAIL: process.env.AUTH_BOOTSTRAP_OWNER_EMAIL,
    AUTH_PLATFORM_ADMIN_EMAILS: process.env.AUTH_PLATFORM_ADMIN_EMAILS,
    AUTH_ALLOWED_SIGNUP_DOMAINS: process.env.AUTH_ALLOWED_SIGNUP_DOMAINS,
  };
  function restoreAuth() {
    for (const [k, v] of Object.entries(AUTH_SNAPSHOT)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetCacheForTesting();
  }
  afterAll(() => restoreAuth());

  it("AUTH_BOOTSTRAP_OWNER_EMAIL: empty is allowed (open mode)", () => {
    delete process.env.AUTH_BOOTSTRAP_OWNER_EMAIL;
    _resetCacheForTesting();
    expect(getEnv().AUTH_BOOTSTRAP_OWNER_EMAIL).toBe("");
    restoreAuth();
  });

  it("AUTH_BOOTSTRAP_OWNER_EMAIL: valid email passes + lowercases", () => {
    process.env.AUTH_BOOTSTRAP_OWNER_EMAIL = "Admin@Acme.COM";
    _resetCacheForTesting();
    expect(getEnv().AUTH_BOOTSTRAP_OWNER_EMAIL).toBe("admin@acme.com");
    restoreAuth();
  });

  it("AUTH_BOOTSTRAP_OWNER_EMAIL: typo without @ is rejected at boot", () => {
    process.env.AUTH_BOOTSTRAP_OWNER_EMAIL = "admin";
    _resetCacheForTesting();
    expect(() => getEnv()).toThrow(/AUTH_BOOTSTRAP_OWNER_EMAIL/);
    restoreAuth();
  });

  it("AUTH_PLATFORM_ADMIN_EMAILS: rejects entries without @", () => {
    process.env.AUTH_PLATFORM_ADMIN_EMAILS = "ops@acme.com,nope";
    _resetCacheForTesting();
    expect(() => getEnv()).toThrow(/AUTH_PLATFORM_ADMIN_EMAILS/);
    restoreAuth();
  });

  it("AUTH_PLATFORM_ADMIN_EMAILS: well-formed list passes", () => {
    process.env.AUTH_PLATFORM_ADMIN_EMAILS = "ops@acme.com, admin@foo.io";
    _resetCacheForTesting();
    expect(getEnv().AUTH_PLATFORM_ADMIN_EMAILS).toEqual(["ops@acme.com", "admin@foo.io"]);
    restoreAuth();
  });

  it("AUTH_ALLOWED_SIGNUP_DOMAINS: rejects malformed entries (whitespace)", () => {
    process.env.AUTH_ALLOWED_SIGNUP_DOMAINS = "acme . com";
    _resetCacheForTesting();
    expect(() => getEnv()).toThrow(/AUTH_ALLOWED_SIGNUP_DOMAINS/);
    restoreAuth();
  });

  it("AUTH_ALLOWED_SIGNUP_DOMAINS: rejects single-label hostnames", () => {
    process.env.AUTH_ALLOWED_SIGNUP_DOMAINS = "acme";
    _resetCacheForTesting();
    expect(() => getEnv()).toThrow(/AUTH_ALLOWED_SIGNUP_DOMAINS/);
    restoreAuth();
  });

  it("AUTH_ALLOWED_SIGNUP_DOMAINS: well-formed list passes + strips '@'", () => {
    process.env.AUTH_ALLOWED_SIGNUP_DOMAINS = "acme.com,@foo.io";
    _resetCacheForTesting();
    expect(getEnv().AUTH_ALLOWED_SIGNUP_DOMAINS).toEqual(["acme.com", "foo.io"]);
    restoreAuth();
  });
});
