// SPDX-License-Identifier: Apache-2.0

/**
 * Unit test for `buildAppConfig()` — the closed-mode flags (issue #228)
 * reach the SPA as booleans, and the variables that name who may get in
 * (`BOOTSTRAP_OWNER_EMAIL`, `PLATFORM_ADMIN_EMAILS`,
 * `ALLOWED_SIGNUP_DOMAINS`) stay server-side — guarded here so nobody
 * widens the projection later.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { buildAppConfig, isSmtpConfigured } from "../../../src/lib/app-config.ts";

const KEYS = [
  "AUTH_BOOTSTRAP_OWNER_EMAIL",
  "AUTH_DISABLE_SIGNUP",
  "AUTH_DISABLE_ORG_CREATION",
  "AUTH_PLATFORM_ADMIN_EMAILS",
  "AUTH_ALLOWED_SIGNUP_DOMAINS",
] as const;

describe("buildAppConfig — closed-mode projection", () => {
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

  it("reports open mode when no closed-mode variable is set", () => {
    const cfg = buildAppConfig();
    expect(cfg.features.signupDisabled).toBe(false);
  });

  it("names nobody who may get in: owner, platform admins and allowed domains stay server-side", () => {
    process.env.AUTH_BOOTSTRAP_OWNER_EMAIL = "admin@acme.com";
    process.env.AUTH_PLATFORM_ADMIN_EMAILS = "ops@example.org,security@example.org";
    process.env.AUTH_ALLOWED_SIGNUP_DOMAINS = "example.org";
    _resetCacheForTesting();
    const serialized = JSON.stringify(buildAppConfig());
    // The page is served to every visitor, signed in or not.
    expect(serialized).not.toContain("admin@acme.com");
    expect(serialized).not.toContain("acme.com");
    expect(serialized).not.toContain("example.org");
  });

  it("reflects closed-mode flags in features", () => {
    process.env.AUTH_DISABLE_SIGNUP = "true";
    _resetCacheForTesting();
    const cfg = buildAppConfig();
    expect(cfg.features.signupDisabled).toBe(true);
  });
});

/**
 * `isSmtpConfigured()` is the one formula behind `features.smtp`, and — since
 * `ModuleInitContext.getSendMail` gates the module-facing mailer on it — the
 * one answer to "will a module's send reach a transport at all". A partial
 * SMTP configuration is NOT configured: nodemailer would accept it and fail
 * per message instead.
 */
describe("isSmtpConfigured", () => {
  const SMTP_KEYS = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;
  const saved: Record<string, string | undefined> = {};

  function setSmtp(values: Partial<Record<(typeof SMTP_KEYS)[number], string>>): void {
    for (const k of SMTP_KEYS) {
      const v = values[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetCacheForTesting();
  }

  beforeEach(() => {
    for (const k of SMTP_KEYS) saved[k] = process.env[k];
    setSmtp({});
  });

  afterEach(() => {
    for (const k of SMTP_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetCacheForTesting();
  });

  const FULL = {
    SMTP_HOST: "smtp.example.com",
    SMTP_USER: "mailer",
    SMTP_PASS: "secret",
    SMTP_FROM: "no-reply@example.com",
  } as const;

  it("is false when no SMTP variable is set", () => {
    expect(isSmtpConfigured()).toBe(false);
  });

  it("is true only when every SMTP variable is set", () => {
    setSmtp(FULL);
    expect(isSmtpConfigured()).toBe(true);
  });

  for (const missing of SMTP_KEYS) {
    it(`is false when ${missing} alone is missing`, () => {
      const partial: Record<string, string> = { ...FULL };
      delete partial[missing];
      setSmtp(partial);
      expect(isSmtpConfigured()).toBe(false);
    });
  }

  it("agrees with the features.smtp flag it backs", () => {
    setSmtp(FULL);
    expect(buildAppConfig().features.smtp).toBe(isSmtpConfigured());
    setSmtp({});
    expect(buildAppConfig().features.smtp).toBe(isSmtpConfigured());
  });
});
