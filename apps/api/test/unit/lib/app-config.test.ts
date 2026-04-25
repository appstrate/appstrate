// SPDX-License-Identifier: Apache-2.0

/**
 * Unit test for `buildAppConfig()` — issue #228 surfaces
 * `AUTH_BOOTSTRAP_OWNER_EMAIL` to the SPA so `RegisterForm` can pre-fill
 * and lock the email field. The two other closed-mode env vars
 * (`PLATFORM_ADMIN_EMAILS`, `ALLOWED_SIGNUP_DOMAINS`) deliberately stay
 * server-side — guarding that asymmetry here prevents an accidental leak
 * if anyone widens the projection later.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { buildAppConfig } from "../../../src/lib/app-config.ts";

const KEYS = [
  "AUTH_BOOTSTRAP_OWNER_EMAIL",
  "AUTH_DISABLE_SIGNUP",
  "AUTH_DISABLE_ORG_CREATION",
  "AUTH_PLATFORM_ADMIN_EMAILS",
  "AUTH_ALLOWED_SIGNUP_DOMAINS",
] as const;

describe("buildAppConfig — bootstrapOwnerEmail surfacing", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    _resetCacheForTesting();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetCacheForTesting();
  });

  it("omits bootstrapOwnerEmail when the env var is unset", () => {
    const cfg = buildAppConfig();
    expect(cfg.bootstrapOwnerEmail).toBeUndefined();
    expect(cfg.features.signupDisabled).toBe(false);
    expect(cfg.features.orgCreationDisabled).toBe(false);
  });

  it("surfaces bootstrapOwnerEmail verbatim when set", () => {
    process.env.AUTH_BOOTSTRAP_OWNER_EMAIL = "admin@acme.com";
    _resetCacheForTesting();
    const cfg = buildAppConfig();
    expect(cfg.bootstrapOwnerEmail).toBe("admin@acme.com");
  });

  it("does not leak the platform-admin allowlist or domain allowlist into the config", () => {
    process.env.AUTH_BOOTSTRAP_OWNER_EMAIL = "admin@acme.com";
    process.env.AUTH_PLATFORM_ADMIN_EMAILS = "ops@example.org,security@example.org";
    process.env.AUTH_ALLOWED_SIGNUP_DOMAINS = "example.org";
    _resetCacheForTesting();
    const cfg = buildAppConfig();
    const serialized = JSON.stringify(cfg);
    // Other admin emails MUST NOT leak — they're operator-only data.
    expect(serialized).not.toContain("ops@example.org");
    expect(serialized).not.toContain("security@example.org");
    // Domain allowlist MUST NOT leak — discloses tenant policy.
    expect(serialized).not.toContain("example.org");
    // Bootstrap email IS surfaced — that's the whole point.
    expect(cfg.bootstrapOwnerEmail).toBe("admin@acme.com");
  });

  it("reflects closed-mode flags in features", () => {
    process.env.AUTH_DISABLE_SIGNUP = "true";
    process.env.AUTH_DISABLE_ORG_CREATION = "true";
    _resetCacheForTesting();
    const cfg = buildAppConfig();
    expect(cfg.features.signupDisabled).toBe(true);
    expect(cfg.features.orgCreationDisabled).toBe(true);
  });
});
