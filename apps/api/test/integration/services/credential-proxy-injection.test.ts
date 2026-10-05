// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for server-side credential header injection in the
 * credential-proxy service.
 *
 * The public `/api/credential-proxy/proxy` endpoint (BYOI / CLI /
 * GitHub Action) reaches a space's integrations from outside
 * Appstrate. `proxyCall()` resolves the integration connection for the
 * caller's actor, builds the `delivery.http` plan, and synthesises the
 * upstream auth header server-side — the caller cannot alter it (the
 * route also strips inbound `Authorization`, consumed by API-key auth
 * before reaching the handler).
 *
 * This test pins that behaviour against `integration_connections`:
 * an `api_key` auth with a `delivery.http` plan injects the configured
 * header; a `custom` auth with no `delivery.http` injects nothing.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { proxyCall } from "../../../src/services/credential-proxy/core.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
  envDelivery,
} from "../../helpers/integration-manifests.ts";
import {
  seedProxyIntegration,
  seedProxyConnection,
} from "../../helpers/credential-proxy-fixtures.ts";

describe("proxyCall — server-side credential injection (integration-backed)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "cpinjectorg" });
  });

  it("injects Authorization: Bearer <token> for an api_key delivery.http plan", async () => {
    const packageId = "@cpinjectorg/gmail";
    await seedProxyIntegration(
      ctx,
      localIntegrationManifest({
        name: packageId,
        displayName: "Gmail",
        description: "Gmail integration",
        auths: {
          api: {
            type: "api_key",
            authorizedUris: ["https://gmail.googleapis.com/**"],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "api_key",
            }),
          },
        },
      }),
    );
    await seedProxyConnection(ctx, packageId, "api", { api_key: "ya29.live-token" });

    let captured: Record<string, string> | undefined;
    const fakeFetch = ((_url: string, init: RequestInit) => {
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

    const res = await proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "GET",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(200);
    expect(captured?.authorization).toBe("Bearer ya29.live-token");
  });

  it("keeps the credential on a cross-origin redirect the allowlist names (Dropbox api. -> content.)", async () => {
    const packageId = "@cpinjectorg/dropbox";
    await seedProxyIntegration(
      ctx,
      localIntegrationManifest({
        name: packageId,
        displayName: "Dropbox",
        description: "Dropbox integration",
        auths: {
          api: {
            type: "api_key",
            authorizedUris: ["https://api.dropboxapi.com/**", "https://content.dropboxapi.com/**"],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "api_key",
            }),
          },
        },
      }),
    );
    const connectionId = await seedProxyConnection(ctx, packageId, "api", { api_key: "sl.tok" });

    const hops: Array<{ url: string; authorization: string | null }> = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      hops.push({ url, authorization: new Headers(init.headers).get("authorization") });
      return Promise.resolve(
        hops.length === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "https://content.dropboxapi.com/2/files/download" },
            })
          : new Response("bytes", { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const res = await proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "POST",
      target: "https://api.dropboxapi.com/2/files/download",
      headers: {},
      fetch: fakeFetch,
      resolveHost: async () => ["162.125.1.1"],
    });

    expect(res.status).toBe(200);
    expect(res.connectionId).toBe(connectionId);
    expect(hops).toEqual([
      { url: "https://api.dropboxapi.com/2/files/download", authorization: "Bearer sl.tok" },
      { url: "https://content.dropboxapi.com/2/files/download", authorization: "Bearer sl.tok" },
    ]);
  });

  it("injects X-Api-Key without prefix when the plan declares it", async () => {
    const packageId = "@cpinjectorg/svc";
    await seedProxyIntegration(
      ctx,
      localIntegrationManifest({
        name: packageId,
        displayName: "Svc",
        description: "Svc integration",
        auths: {
          api: {
            type: "api_key",
            authorizedUris: ["https://api.example.com/**"],
            delivery: httpHeaderDelivery({ name: "X-Api-Key", field: "api_key" }),
          },
        },
      }),
    );
    await seedProxyConnection(ctx, packageId, "api", { api_key: "sk_live_abc" });

    let captured: Record<string, string> | undefined;
    const fakeFetch = ((_url: string, init: RequestInit) => {
      captured = {};
      new Headers(init.headers).forEach((v, k) => {
        captured![k] = v;
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const res = await proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "GET",
      target: "https://api.example.com/resource",
      headers: {},
      fetch: fakeFetch,
    });

    expect(res.status).toBe(200);
    expect(captured?.["x-api-key"]).toBe("sk_live_abc");
    expect(captured?.authorization).toBeUndefined();
  });

  it("does not inject when the auth declares no delivery.http (custom)", async () => {
    const packageId = "@cpinjectorg/custom";
    await seedProxyIntegration(
      ctx,
      localIntegrationManifest({
        name: packageId,
        displayName: "Custom",
        description: "Custom integration",
        auths: {
          custom: {
            type: "custom",
            authorizedUris: ["https://api.example.com/**"],
            credentialFields: ["username", "password"],
            delivery: envDelivery({ TOKEN: "username" }),
          },
        },
      }),
    );
    await seedProxyConnection(ctx, packageId, "custom", { username: "admin", password: "s3cret" });

    let captured: Record<string, string> | undefined;
    const fakeFetch = ((_url: string, init: RequestInit) => {
      captured = {};
      new Headers(init.headers).forEach((v, k) => {
        captured![k] = v;
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    await proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "GET",
      target: "https://api.example.com/thing",
      headers: {},
      fetch: fakeFetch,
    });

    expect(captured?.authorization).toBeUndefined();
  });

  it("replaces a caller-supplied non-Authorization header by default", async () => {
    const packageId = "@cpinjectorg/dual";
    await seedProxyIntegration(
      ctx,
      localIntegrationManifest({
        name: packageId,
        displayName: "Dual",
        description: "Dual integration",
        auths: {
          api: {
            type: "api_key",
            authorizedUris: ["https://api.example.com/**"],
            delivery: httpHeaderDelivery({ name: "X-Api-Key", field: "api_key" }),
          },
        },
      }),
    );
    await seedProxyConnection(ctx, packageId, "api", { api_key: "platform-pinned-key" });

    let captured: Record<string, string> | undefined;
    const fakeFetch = ((_url: string, init: RequestInit) => {
      captured = {};
      new Headers(init.headers).forEach((v, k) => {
        captured![k] = v;
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    await proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "GET",
      target: "https://api.example.com/thing",
      headers: { "x-api-key": "caller-override-key" },
      fetch: fakeFetch,
    });

    expect(captured?.["x-api-key"]).toBe("platform-pinned-key");
  });

  it("strips an allowed caller override on redirect even when the platform value is empty", async () => {
    const packageId = "@cpinjectorg/override";
    await seedProxyIntegration(
      ctx,
      localIntegrationManifest({
        name: packageId,
        displayName: "Override",
        description: "Override integration",
        auths: {
          api: {
            type: "api_key",
            authorizedUris: ["https://1.1.1.1/**"],
            allowAllUris: true,
            delivery: httpHeaderDelivery({
              name: "X-Api-Key",
              field: "api_key",
              allowServerOverride: true,
            }),
          },
        },
      }),
    );
    await seedProxyConnection(ctx, packageId, "api", { api_key: "" });

    const captured: Array<Record<string, string>> = [];
    const fakeFetch = ((url: string | URL, init: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
      captured.push(headers);
      if (url.toString().startsWith("https://1.1.1.1")) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://8.8.8.8/redirected" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 401 }));
    }) as unknown as typeof fetch;

    await proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "GET",
      target: "https://1.1.1.1/thing",
      headers: { "x-api-key": "caller-override-key" },
      fetch: fakeFetch,
    });

    expect(captured[0]?.["x-api-key"]).toBe("caller-override-key");
    expect(captured[1]?.["x-api-key"]).toBeUndefined();
    const [connection] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, packageId));
    expect(connection?.needsReconnection).toBe(false);
  });

  // `intranet.corp` is in the test preload's EGRESS_ALLOW_INTERNAL_HOSTS.
  it.each([
    ["names it literally", "https://intranet.corp/**", true],
    ["takes it from the connection", "https://{$credential.host}/**", false],
  ])(
    "reaches an operator-listed internal host only when authorized_uris %s",
    async (_label, pattern, reached) => {
      const packageId = `@cpinjectorg/internal-${reached ? "literal" : "rendered"}`;
      await seedProxyIntegration(
        ctx,
        localIntegrationManifest({
          name: packageId,
          displayName: "Internal",
          description: "Internal API",
          auths: {
            api: {
              type: "api_key",
              authorizedUris: [pattern],
              credentialFields: ["api_key", "host"],
              requiredCredentialFields: ["api_key", "host"],
              delivery: httpHeaderDelivery({ name: "X-Api-Key", field: "api_key" }),
            },
          },
        }),
      );
      await seedProxyConnection(ctx, packageId, "api", { api_key: "k", host: "intranet.corp" });

      let sent = 0;
      const call = proxyCall({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        actor: { type: "user", id: ctx.user.id },
        integrationId: packageId,
        method: "GET",
        target: "https://intranet.corp/api/x",
        headers: {},
        fetch: (() => {
          sent++;
          return Promise.resolve(new Response("{}"));
        }) as unknown as typeof fetch,
        resolveHost: async () => ["10.0.0.5"],
      });

      if (reached) expect((await call).status).toBe(200);
      else await expect(call).rejects.toMatchObject({ code: "blocked_target" });
      expect(sent).toBe(reached ? 1 : 0);
    },
  );

  /** An api_key integration injecting `Authorization: Bearer <api_key>`, caller override allowed. */
  async function seedOverridable(packageId: string): Promise<void> {
    await seedProxyIntegration(
      ctx,
      localIntegrationManifest({
        name: packageId,
        displayName: "Overridable",
        description: "Overridable integration",
        auths: {
          api: {
            type: "api_key",
            authorizedUris: ["https://api.example.com/**"],
            credentialFields: ["api_key", "alt"],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "api_key",
              allowServerOverride: true,
            }),
          },
        },
      }),
    );
    await seedProxyConnection(ctx, packageId, "api", { api_key: "platform", alt: "other" });
  }

  it("repairs `Bearer{{field}}` in a caller Authorization the manifest lets override", async () => {
    const packageId = "@cpinjectorg/repair";
    await seedOverridable(packageId);
    const authorization: Array<string | null> = [];
    await proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "GET",
      target: "https://api.example.com/x",
      headers: { authorization: "Bearer{{alt}}" },
      fetch: ((_url: string, init: RequestInit) => {
        authorization.push(new Headers(init.headers).get("authorization"));
        return Promise.resolve(new Response("{}"));
      }) as unknown as typeof fetch,
    });
    expect(authorization).toEqual(["Bearer other"]);
  });

  it("refuses an unresolved header placeholder before the URL policy is consulted", async () => {
    const packageId = "@cpinjectorg/header-unresolved";
    await seedOverridable(packageId);
    let sent = 0;
    const call = proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "GET",
      // Off the allowlist with a templated credential: alone, the URL policy's refusal.
      target: "https://elsewhere.example.net/x",
      headers: { "X-Key": "{{alt}}", "X-Other": "{{nope}}" },
      fetch: (() => {
        sent++;
        return Promise.resolve(new Response("{}"));
      }) as unknown as typeof fetch,
    });
    await expect(call).rejects.toMatchObject({
      code: "unresolved_placeholder",
      message: 'Unresolved placeholders in header "X-Other": {{nope}}',
    });
    expect(sent).toBe(0);
  });

  it("refuses with unresolved_placeholder (fail-closed) when the target references an unresolved {{field}}", async () => {
    const packageId = "@cpinjectorg/failclosed";
    await seedProxyIntegration(
      ctx,
      localIntegrationManifest({
        name: packageId,
        displayName: "FailClosed",
        description: "FailClosed integration",
        auths: {
          api: {
            type: "api_key",
            // `**` allows any path, so the only gate that can fire is the
            // unresolved-placeholder fail-closed check — not the allowlist.
            authorizedUris: ["https://api.example.com/**"],
            delivery: httpHeaderDelivery({ name: "X-Api-Key", field: "api_key" }),
          },
        },
      }),
    );
    // Resolved credential fields = { api_key }. The target references
    // {{mailbox}}, which is NOT a credential field → must fail closed.
    await seedProxyConnection(ctx, packageId, "api", { api_key: "sk_live_abc" });

    let upstreamHit = false;
    const fakeFetch = (() => {
      upstreamHit = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    await expect(
      proxyCall({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        actor: { type: "user", id: ctx.user.id },
        integrationId: packageId,
        method: "GET",
        target: "https://api.example.com/users/{{mailbox}}/messages",
        headers: {},
        fetch: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: "unresolved_placeholder" });

    // Fail-closed: the upstream fetch must never be issued.
    expect(upstreamHit).toBe(false);
  });
});
