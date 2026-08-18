// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the two pieces that make an integration OAuth failure
 * legible to an operator:
 *
 *   - `integrationCallbackUrl` — the `redirect_uri` the connect strategy
 *     sends AND the admin UI displays. A drift between those two is the
 *     single most common connect failure, so the value has one source.
 *   - `normalizeOAuthErrorCode` / `oauthDiagnosticSuffix` — how much of a
 *     provider-supplied error reaches the public callback page.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import {
  integrationCallbackUrl,
  INTEGRATION_CALLBACK_PATH,
} from "../../../src/lib/integration-callback-url.ts";
import {
  normalizeOAuthErrorCode,
  oauthDiagnosticSuffix,
} from "../../../src/lib/oauth-error-diagnostic.ts";

const SNAPSHOT = { APP_URL: process.env.APP_URL };

function restore() {
  if (SNAPSHOT.APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = SNAPSHOT.APP_URL;
  _resetCacheForTesting();
}

beforeEach(() => {
  _resetCacheForTesting();
});

afterAll(restore);

describe("integrationCallbackUrl", () => {
  it("is APP_URL + the shared callback path", () => {
    process.env.APP_URL = "https://app.example.com";
    _resetCacheForTesting();
    expect(integrationCallbackUrl()).toBe("https://app.example.com/api/integrations/callback");
    restore();
  });

  it("tracks APP_URL rather than any fixed host", () => {
    process.env.APP_URL = "http://localhost:3000";
    _resetCacheForTesting();
    expect(integrationCallbackUrl()).toBe("http://localhost:3000/api/integrations/callback");
    restore();
  });

  // `APP_URL` is normalized to `url.origin` by the env schema, so a configured
  // trailing slash never reaches here. Pinned because a provider compares
  // `redirect_uri` byte-for-byte: `…com//api/…` would be a different URI than
  // the one the strategy registers, and the failure is opaque at the provider.
  it("emits no double slash when APP_URL is written with a trailing slash", () => {
    process.env.APP_URL = "https://app.example.com/";
    _resetCacheForTesting();
    expect(integrationCallbackUrl()).toBe("https://app.example.com/api/integrations/callback");
    restore();
  });

  it("exposes the path used by the route table", () => {
    expect(INTEGRATION_CALLBACK_PATH).toBe("/api/integrations/callback");
  });
});

describe("normalizeOAuthErrorCode", () => {
  it("passes registered RFC 6749 error codes through", () => {
    for (const code of [
      "invalid_client",
      "invalid_grant",
      "unauthorized_client",
      "access_denied",
      "invalid_scope",
    ]) {
      expect(normalizeOAuthErrorCode(code)).toBe(code);
    }
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeOAuthErrorCode("  invalid_client\n")).toBe("invalid_client");
  });

  it("drops values that are not code-shaped", () => {
    // The `error` query parameter is attacker-reachable: the callback route is
    // public and unauthenticated, so anything rendered from it is a phishing
    // surface. Prose, markup and oversized blobs are refused outright rather
    // than escaped and shown.
    expect(normalizeOAuthErrorCode("<img src=x onerror=alert(1)>")).toBeUndefined();
    expect(
      normalizeOAuthErrorCode("Your account has been suspended, call 555-0100"),
    ).toBeUndefined();
    expect(normalizeOAuthErrorCode("a".repeat(65))).toBeUndefined();
    expect(normalizeOAuthErrorCode("")).toBeUndefined();
    expect(normalizeOAuthErrorCode("   ")).toBeUndefined();
  });

  it("returns undefined when no code was supplied", () => {
    expect(normalizeOAuthErrorCode(undefined)).toBeUndefined();
  });
});

describe("oauthDiagnosticSuffix", () => {
  it("prefers the OAuth error code over the HTTP status", () => {
    expect(oauthDiagnosticSuffix("invalid_client", 401)).toBe(" (invalid_client)");
  });

  it("falls back to the HTTP status when the provider named no code", () => {
    expect(oauthDiagnosticSuffix(undefined, 401)).toBe(" (HTTP 401)");
  });

  it("falls back to the HTTP status when the code is not code-shaped", () => {
    expect(oauthDiagnosticSuffix("<html>Unauthorized</html>", 401)).toBe(" (HTTP 401)");
  });

  it("is empty for a network-level failure (no code, no status)", () => {
    expect(oauthDiagnosticSuffix(undefined, undefined)).toBe("");
  });

  // `error_description` is provider-controlled prose that some IdPs use to
  // echo the rejected authorization code back, so it has no path to the page:
  // the function takes the code and the status, and nothing else.
  it("takes no description parameter to leak", () => {
    expect(oauthDiagnosticSuffix.length).toBe(2);
  });
});
