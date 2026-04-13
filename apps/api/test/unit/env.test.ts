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
