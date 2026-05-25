// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for server-side credential header injection in the
 * credential-proxy service.
 *
 * The public `/api/credential-proxy/proxy` endpoint (BYOI / CLI /
 * GitHub Action) reaches an application's integrations from outside
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
import { seedPackage } from "../../helpers/seed.ts";
import { applicationPackages, integrationConnections } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { proxyCall, ProxySubstitutionError } from "../../../src/services/credential-proxy/core.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
  envDelivery,
} from "../../helpers/integration-manifests.ts";

async function seedIntegration(orgId: string, manifest: IntegrationManifest) {
  return seedPackage({
    id: manifest.name,
    orgId,
    type: "integration",
    source: "local",
    draftManifest: manifest,
  });
}

async function installAndConnect(
  ctx: TestContext,
  packageId: string,
  authKey: string,
  fields: Record<string, string>,
): Promise<void> {
  await db.insert(applicationPackages).values({
    applicationId: ctx.defaultAppId,
    packageId,
    config: {},
  });
  await db.insert(integrationConnections).values({
    integrationPackageId: packageId,
    authKey,
    accountId: "acct-1",
    applicationId: ctx.defaultAppId,
    userId: ctx.user.id,
    credentialsEncrypted: encryptCredentials(fields),
    scopesGranted: [],
    sharedWithOrg: false,
  });
}

describe("proxyCall — server-side credential injection (integration-backed)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "cpinjectorg" });
  });

  it("injects Authorization: Bearer <token> for an api_key delivery.http plan", async () => {
    const packageId = "@cpinjectorg/gmail";
    await seedIntegration(
      ctx.orgId,
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
    await installAndConnect(ctx, packageId, "api", { api_key: "ya29.live-token" });

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
      applicationId: ctx.defaultAppId,
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

  it("injects X-Api-Key without prefix when the plan declares it", async () => {
    const packageId = "@cpinjectorg/svc";
    await seedIntegration(
      ctx.orgId,
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
    await installAndConnect(ctx, packageId, "api", { api_key: "sk_live_abc" });

    let captured: Record<string, string> | undefined;
    const fakeFetch = ((_url: string, init: RequestInit) => {
      captured = {};
      new Headers(init.headers).forEach((v, k) => {
        captured![k] = v;
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const res = await proxyCall({
      applicationId: ctx.defaultAppId,
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
    await seedIntegration(
      ctx.orgId,
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
    await installAndConnect(ctx, packageId, "custom", { username: "admin", password: "s3cret" });

    let captured: Record<string, string> | undefined;
    const fakeFetch = ((_url: string, init: RequestInit) => {
      captured = {};
      new Headers(init.headers).forEach((v, k) => {
        captured![k] = v;
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    await proxyCall({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "GET",
      target: "https://api.example.com/thing",
      headers: {},
      fetch: fakeFetch,
    });

    expect(captured?.authorization).toBeUndefined();
  });

  it("respects a caller-supplied non-Authorization header override", async () => {
    const packageId = "@cpinjectorg/dual";
    await seedIntegration(
      ctx.orgId,
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
    await installAndConnect(ctx, packageId, "api", { api_key: "platform-pinned-key" });

    let captured: Record<string, string> | undefined;
    const fakeFetch = ((_url: string, init: RequestInit) => {
      captured = {};
      new Headers(init.headers).forEach((v, k) => {
        captured![k] = v;
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    await proxyCall({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "GET",
      target: "https://api.example.com/thing",
      headers: { "x-api-key": "caller-override-key" },
      fetch: fakeFetch,
    });

    expect(captured?.["x-api-key"]).toBe("caller-override-key");
  });

  it("throws ProxySubstitutionError (fail-closed) when the target references an unresolved {{field}}", async () => {
    const packageId = "@cpinjectorg/failclosed";
    await seedIntegration(
      ctx.orgId,
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
    await installAndConnect(ctx, packageId, "api", { api_key: "sk_live_abc" });

    let upstreamHit = false;
    const fakeFetch = (() => {
      upstreamHit = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    await expect(
      proxyCall({
        applicationId: ctx.defaultAppId,
        actor: { type: "user", id: ctx.user.id },
        integrationId: packageId,
        method: "GET",
        target: "https://api.example.com/users/{{mailbox}}/messages",
        headers: {},
        fetch: fakeFetch,
      }),
    ).rejects.toBeInstanceOf(ProxySubstitutionError);

    // Fail-closed: the upstream fetch must never be issued.
    expect(upstreamHit).toBe(false);
  });
});
