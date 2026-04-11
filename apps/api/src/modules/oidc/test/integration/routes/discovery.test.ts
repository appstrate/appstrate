// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 8414 + OpenID Connect Discovery tests for the OIDC module's root-level
 * well-known endpoints.
 *
 * The module router is mounted at the HTTP origin root, so satellites find
 * the discovery document at `${APP_URL}/.well-known/openid-configuration`
 * and `${APP_URL}/.well-known/oauth-authorization-server` — exactly where
 * real-world OIDC client libraries look for them. See `createOidcRouter`
 * in `routes.ts` for the full spec rationale.
 *
 * Why dedicated coverage: `oauth-flows.test.ts` exercises the discovery
 * document as a side-effect of extracting the authorize/token URLs for its
 * PKCE flow, but it does not assert the document is *RFC 8414-shaped* —
 * issuer, endpoint URLs, advertised scopes + response types + PKCE methods,
 * cache headers. Any future plugin upgrade that quietly drops a field (e.g.
 * `jwks_uri`, `code_challenge_methods_supported`) would break satellites
 * that auto-configure from this document, and the flow test would still
 * pass because it reads what it needs and ignores the rest. These tests
 * lock the contract down.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import oidcModule from "../../../index.ts";
import { APPSTRATE_SCOPES } from "../../../auth/scopes.ts";

const app = getTestApp({ modules: [oidcModule] });

interface OpenIdConfigShape {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  subject_types_supported?: string[];
}

async function fetchJson<T>(path: string): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await app.request(path);
  const body = (await res.json()) as T;
  return { status: res.status, body, headers: res.headers };
}

describe("OIDC discovery — RFC 8414 + OpenID Connect Discovery", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });

  describe("GET /.well-known/openid-configuration", () => {
    it("returns a well-formed OpenID Connect discovery document", async () => {
      const { status, body } = await fetchJson<OpenIdConfigShape>(
        "/.well-known/openid-configuration",
      );
      expect(status).toBe(200);

      // Required OIDC fields
      expect(typeof body.issuer).toBe("string");
      expect(body.issuer.length).toBeGreaterThan(0);
      expect(typeof body.authorization_endpoint).toBe("string");
      expect(body.authorization_endpoint).toContain("/oauth2/authorize");
      expect(typeof body.token_endpoint).toBe("string");
      expect(body.token_endpoint).toContain("/oauth2/token");
      expect(typeof body.jwks_uri).toBe("string");
      expect(body.jwks_uri).toContain("/jwks");

      // Response + grant type advertisement — satellites key off these
      // to decide which OAuth flow to use.
      expect(body.response_types_supported).toBeDefined();
      expect(body.response_types_supported).toContain("code");
      expect(body.grant_types_supported).toBeDefined();
      expect(body.grant_types_supported).toContain("authorization_code");
      expect(body.grant_types_supported).toContain("refresh_token");

      // OAuth 2.1 requires PKCE S256. `plain` must not be advertised.
      expect(body.code_challenge_methods_supported).toBeDefined();
      expect(body.code_challenge_methods_supported).toContain("S256");
      expect(body.code_challenge_methods_supported).not.toContain("plain");
    });

    it("advertises the full APPSTRATE_SCOPES vocabulary", async () => {
      const { body } = await fetchJson<OpenIdConfigShape>("/.well-known/openid-configuration");
      expect(body.scopes_supported).toBeDefined();
      // Every entry of APPSTRATE_SCOPES (identity scopes + OIDC_ALLOWED_SCOPES)
      // must appear in `scopes_supported`. This is the contract the admin
      // UI + satellite registrations rely on.
      for (const scope of APPSTRATE_SCOPES) {
        expect(body.scopes_supported).toContain(scope);
      }
      // Identity scopes are non-negotiable — assert them individually so
      // a regression here is obvious in the failure message.
      expect(body.scopes_supported).toContain("openid");
      expect(body.scopes_supported).toContain("profile");
      expect(body.scopes_supported).toContain("email");
      expect(body.scopes_supported).toContain("offline_access");
    });

    it("sets a public cache-control header", async () => {
      const { headers } = await fetchJson<OpenIdConfigShape>("/.well-known/openid-configuration");
      const cache = headers.get("cache-control") ?? "";
      expect(cache).toContain("public");
      // 1h TTL — satellites should not hammer the discovery endpoint on
      // every request.
      expect(cache).toContain("max-age=3600");
    });
  });

  describe("GET /.well-known/oauth-authorization-server", () => {
    it("returns a well-formed RFC 8414 authorization server metadata document", async () => {
      const { status, body } = await fetchJson<OpenIdConfigShape>(
        "/.well-known/oauth-authorization-server",
      );
      expect(status).toBe(200);

      // RFC 8414 requires issuer + authorization_endpoint + token_endpoint
      // + response_types_supported at a minimum.
      expect(typeof body.issuer).toBe("string");
      expect(body.issuer.length).toBeGreaterThan(0);
      expect(body.authorization_endpoint).toContain("/oauth2/authorize");
      expect(body.token_endpoint).toContain("/oauth2/token");
      expect(body.response_types_supported).toContain("code");
      expect(body.code_challenge_methods_supported).toContain("S256");
    });

    it("sets a public cache-control header", async () => {
      const { headers } = await fetchJson<OpenIdConfigShape>(
        "/.well-known/oauth-authorization-server",
      );
      expect(headers.get("cache-control") ?? "").toContain("max-age=3600");
    });
  });
});
