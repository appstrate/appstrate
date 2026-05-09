// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for server-side credential header injection in the
 * credential-proxy service.
 *
 * Before Option C (issue #250), `proxyCall()` forwarded whatever
 * headers the caller supplied but never synthesised the upstream auth
 * header — OAuth providers through the public
 * `/api/credential-proxy/proxy` endpoint (BYOI / CLI / GitHub Action)
 * silently failed with 401 because the route also strips inbound
 * `Authorization` (it is consumed by API-key auth before reaching the
 * route handler).
 *
 * This test pins the new behaviour: for a provider manifest that
 * declares `credentialHeaderName` + `credentialHeaderPrefix` (OAuth2
 * pattern) or `credentialHeaderName` alone (API-key pattern), the
 * service writes the final header server-side from
 * `credentials[credentialFieldName]`. The header value the upstream
 * sees is pinned by the platform — the caller cannot alter it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedConnectionProfile, seedPackage, seedConnectionForApp } from "../../helpers/seed.ts";
import { proxyCall } from "../../../src/services/credential-proxy/core.ts";

describe("proxyCall — server-side credential injection", () => {
  let ctx: TestContext;
  let connectionProfileId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "cpinjectorg" });
    const profile = await seedConnectionProfile({
      applicationId: ctx.defaultAppId,
      name: "Default",
      isDefault: true,
    });
    connectionProfileId = profile.id;
  });

  it("injects Authorization: Bearer <token> for an OAuth2 provider", async () => {
    const providerId = "@cpinjectorg/gmail";
    await seedPackage({
      orgId: null,
      id: providerId,
      type: "provider",
      source: "system",
      draftManifest: {
        name: providerId,
        version: "1.0.0",
        type: "provider",
        definition: {
          authMode: "oauth2",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          authorizedUris: ["https://gmail.googleapis.com/**"],
        },
      },
    });
    await seedConnectionForApp(connectionProfileId, providerId, ctx.orgId, ctx.defaultAppId, {
      access_token: "ya29.live-oauth-token",
    });

    let captured: Record<string, string> | undefined;
    const fakeFetch = ((url: string, init: RequestInit) => {
      void url;
      captured = {};
      new Headers(init.headers).forEach((v, k) => {
        captured![k] = v;
      });
      return Promise.resolve(
        new Response('{"messages":[]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const res = await proxyCall(db, {
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      connectionProfileId,
      providerId,
      method: "GET",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(200);
    // Header names normalize to lowercase through the Headers constructor
    expect(captured?.authorization).toBe("Bearer ya29.live-oauth-token");
  });

  it("injects X-Api-Key: <key> without prefix for an api_key provider", async () => {
    const providerId = "@cpinjectorg/svc";
    await seedPackage({
      orgId: null,
      id: providerId,
      type: "provider",
      source: "system",
      draftManifest: {
        name: providerId,
        version: "1.0.0",
        type: "provider",
        definition: {
          authMode: "api_key",
          credentialHeaderName: "X-Api-Key",
          authorizedUris: ["https://api.example.com/**"],
          credentials: { fieldName: "api_key" },
        },
      },
    });
    await seedConnectionForApp(connectionProfileId, providerId, ctx.orgId, ctx.defaultAppId, {
      api_key: "sk_live_abc",
    });

    let captured: Record<string, string> | undefined;
    const fakeFetch = ((_url: string, init: RequestInit) => {
      captured = {};
      new Headers(init.headers).forEach((v, k) => {
        captured![k] = v;
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const res = await proxyCall(db, {
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      connectionProfileId,
      providerId,
      method: "GET",
      target: "https://api.example.com/resource",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(200);
    expect(captured?.["x-api-key"]).toBe("sk_live_abc");
    // Authorization must stay unset — api_key providers do not use Bearer.
    expect(captured?.authorization).toBeUndefined();
  });

  it("does not inject when the manifest omits credentialHeaderName", async () => {
    // basic/custom provider — the agent is expected to write its own
    // auth (e.g. a rendered basic-auth header). The service must not
    // synthesise anything, otherwise it would leak the access_token
    // field into headers that have no standard meaning.
    const providerId = "@cpinjectorg/custom";
    await seedPackage({
      orgId: null,
      id: providerId,
      type: "provider",
      source: "system",
      draftManifest: {
        name: providerId,
        version: "1.0.0",
        type: "provider",
        definition: {
          authMode: "basic",
          authorizedUris: ["https://api.example.com/**"],
        },
      },
    });
    await seedConnectionForApp(connectionProfileId, providerId, ctx.orgId, ctx.defaultAppId, {
      username: "admin",
      password: "s3cret",
    });

    let captured: Record<string, string> | undefined;
    const fakeFetch = ((_url: string, init: RequestInit) => {
      captured = {};
      new Headers(init.headers).forEach((v, k) => {
        captured![k] = v;
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    await proxyCall(db, {
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      connectionProfileId,
      providerId,
      method: "GET",
      target: "https://api.example.com/thing",
      headers: {},
      fetch: fakeFetch,
    });

    expect(captured?.authorization).toBeUndefined();
  });

  it("respects a caller-supplied non-Authorization override (case-insensitive)", async () => {
    // Symmetric with the sidecar: custom header providers can be
    // overridden by the caller for exotic dual-auth flows. The
    // credential-proxy route already strips `Authorization` itself at
    // the HTTP edge (PROXY_CONTROL_HEADERS), so only non-Authorization
    // overrides reach proxyCall in practice.
    const providerId = "@cpinjectorg/dual";
    await seedPackage({
      orgId: null,
      id: providerId,
      type: "provider",
      source: "system",
      draftManifest: {
        name: providerId,
        version: "1.0.0",
        type: "provider",
        definition: {
          authMode: "api_key",
          credentialHeaderName: "X-Api-Key",
          authorizedUris: ["https://api.example.com/**"],
          credentials: { fieldName: "api_key" },
        },
      },
    });
    await seedConnectionForApp(connectionProfileId, providerId, ctx.orgId, ctx.defaultAppId, {
      api_key: "platform-pinned-key",
    });

    let captured: Record<string, string> | undefined;
    const fakeFetch = ((_url: string, init: RequestInit) => {
      captured = {};
      new Headers(init.headers).forEach((v, k) => {
        captured![k] = v;
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    await proxyCall(db, {
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      connectionProfileId,
      providerId,
      method: "GET",
      target: "https://api.example.com/thing",
      headers: { "x-api-key": "caller-override-key" },
      fetch: fakeFetch,
    });

    expect(captured?.["x-api-key"]).toBe("caller-override-key");
  });
});
