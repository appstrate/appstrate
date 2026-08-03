// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the admin-CRUD redirect-URI validator
 * (`services/redirect-uri.ts → isValidRedirectUri`).
 *
 * Regression for #1012: the admin path used to allow `http://` loopback
 * redirects only when the platform itself ran in dev mode
 * (`isDevEnvironment()`), so a native/CLI client registered by hand with
 * `http://127.0.0.1/callback` was rejected on any https deployment — even
 * though the exact same client self-registers fine through Dynamic Client
 * Registration. The validator now accepts `http://` for any loopback host
 * (RFC 8252 §7.3) regardless of environment, using the very predicate the DCR
 * path uses. These assertions are pure (no `APP_URL` / env dependency), which
 * is itself part of the fix; the route-level counterpart (a real `POST
 * /api/oauth/clients` under an https `APP_URL`) lives in
 * `src/modules/oidc/test/integration/routes/oauth-clients.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import { isValidRedirectUri } from "../../src/modules/oidc/services/redirect-uri.ts";

describe("isValidRedirectUri", () => {
  it("accepts http:// loopback redirects regardless of environment (RFC 8252 §7.3)", () => {
    // #1012: these must pass on a production (https APP_URL) deployment.
    expect(isValidRedirectUri("http://127.0.0.1/callback")).toBe(true);
    expect(isValidRedirectUri("http://localhost:63785/callback")).toBe(true);
    expect(isValidRedirectUri("http://[::1]:54321/callback")).toBe(true);
    expect(isValidRedirectUri("http://127.5.6.7/cb")).toBe(true);
  });

  it("accepts the loopback forms DCR accepts, not just the three obvious literals", () => {
    // The predicate is shared with the DCR path (`@better-auth/core/utils/host`),
    // so these edge forms — which a hand-rolled `localhost | 127.x | [::1]`
    // check would reject — behave identically on both registration paths.
    expect(isValidRedirectUri("http://tenant.localhost:5173/callback")).toBe(true); // RFC 6761
    expect(isValidRedirectUri("http://[::ffff:127.0.0.1]/callback")).toBe(true); // IPv4-mapped
    expect(isValidRedirectUri("http://localhost./callback")).toBe(true); // trailing dot
  });

  it("rejects http:// for any non-loopback host", () => {
    expect(isValidRedirectUri("http://app.example.com/callback")).toBe(false);
    expect(isValidRedirectUri("http://169.254.169.254/callback")).toBe(false);
    expect(isValidRedirectUri("http://127.example.com/callback")).toBe(false);
    expect(isValidRedirectUri("http://localhost.evil.com/callback")).toBe(false);
    expect(isValidRedirectUri("http://0.0.0.0/callback")).toBe(false); // unspecified ≠ loopback
  });

  it("accepts https:// for ordinary public hosts", () => {
    expect(isValidRedirectUri("https://app.example.com/callback")).toBe(true);
  });

  it("rejects https:// targets that resolve to SSRF-blocked networks", () => {
    expect(isValidRedirectUri("https://169.254.169.254/")).toBe(false);
    expect(isValidRedirectUri("https://10.0.0.1/callback")).toBe(false);
  });

  it("keeps accepting loopback when APP_URL is an https production origin", () => {
    // The baseline gated this on `isDevEnvironment()` (APP_URL itself being a
    // localhost URL), which is exactly what made #1012 a production-only bug.
    // Flipping APP_URL must now change nothing.
    const previous = process.env.APP_URL;
    process.env.APP_URL = "https://appstrate.example.com";
    resetEnvCache();
    try {
      expect(isValidRedirectUri("http://127.0.0.1:63785/callback")).toBe(true);
      expect(isValidRedirectUri("http://localhost/callback")).toBe(true);
      expect(isValidRedirectUri("http://[::1]/callback")).toBe(true);
      expect(isValidRedirectUri("http://app.example.com/callback")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = previous;
      resetEnvCache();
    }
  });

  it("rejects non-http(s) schemes and unparseable input", () => {
    expect(isValidRedirectUri("javascript:alert(1)//evil")).toBe(false);
    expect(isValidRedirectUri("data:text/html,x")).toBe(false);
    expect(isValidRedirectUri("file:///etc/passwd")).toBe(false);
    expect(isValidRedirectUri("not a url")).toBe(false);
  });
});
