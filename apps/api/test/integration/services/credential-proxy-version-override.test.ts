// SPDX-License-Identifier: Apache-2.0

/**
 * `proxyCall`'s internal `version` override: outside a run, a caller of the service (the server
 * sync of a draft) may authorize the call against the integration's draft instead of its latest
 * published version. A run's frozen version is the only answer for a run, and the public proxy
 * route never sets the override.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { packages, spacePackages } from "@appstrate/db/schema";
import { truncateAll, db } from "../../helpers/db.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { getTestApp } from "../../helpers/app.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey, seedPackage } from "../../helpers/seed.ts";
import { proxyCall, ProxyCallError } from "../../../src/services/credential-proxy/core.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";
import {
  seedProxyConnection,
  seedProxyIntegration,
} from "../../helpers/credential-proxy-fixtures.ts";

const ID = "@cpversion/docs";
const PUBLISHED_HOST = "https://published.example";
const DRAFT_HOST = "https://draft.example";
const DRAFT = { source: "draft", version: null } as const;

const manifestAuthorizing = (host: string) =>
  localIntegrationManifest({
    name: ID,
    auths: {
      api: {
        type: "api_key",
        authorizedUris: [`${host}/**`],
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "api_key",
        }),
      },
    },
  });

const okFetch = (seen: string[]) =>
  ((url: string | URL | Request) => {
    seen.push(String(url instanceof Request ? url.url : url));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;

describe("proxyCall — internal version override", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "cpversion" });
  });

  const call = (target: string, seen: string[], extra: Record<string, unknown> = {}) =>
    proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      reach: "own",
      integrationId: ID,
      method: "GET",
      target,
      headers: {},
      fetch: okFetch(seen),
      resolveHost: async () => ["93.184.216.34"],
      ...extra,
    });

  /** Published authorizes one host, the draft another. */
  async function seedDivergingDraft(): Promise<void> {
    await seedProxyIntegration(ctx, manifestAuthorizing(PUBLISHED_HOST));
    await db
      .update(packages)
      .set({ draftManifest: manifestAuthorizing(DRAFT_HOST) })
      .where(eq(packages.id, ID));
    await seedProxyConnection(ctx, ID, "api", { api_key: "sk-live" });
  }

  it("authorizes against the latest published version by default", async () => {
    await seedDivergingDraft();
    const seen: string[] = [];
    expect((await call(`${PUBLISHED_HOST}/v1`, seen)).status).toBe(200);
    const refused = await call(`${DRAFT_HOST}/v1`, seen).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ProxyCallError);
    expect((refused as ProxyCallError).code).toBe("unauthorized_target");
    expect(seen).toEqual([`${PUBLISHED_HOST}/v1`]);
  });

  it("authorizes against the draft's authorized_uris when the override names it", async () => {
    await seedDivergingDraft();
    const seen: string[] = [];
    expect((await call(`${DRAFT_HOST}/v1`, seen, { version: DRAFT })).status).toBe(200);
    const refused = await call(`${PUBLISHED_HOST}/v1`, seen, { version: DRAFT }).catch(
      (err: unknown) => err,
    );
    expect((refused as ProxyCallError).code).toBe("unauthorized_target");
    expect(seen).toEqual([`${DRAFT_HOST}/v1`]);
  });

  it("reaches a never-published draft only through the override", async () => {
    await seedPackage({
      id: ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifestAuthorizing(DRAFT_HOST),
    });
    await db
      .insert(spacePackages)
      .values({ enabled: true, spaceId: ctx.defaultSpaceId, packageId: ID });
    await seedProxyConnection(ctx, ID, "api", { api_key: "sk-live" });
    const seen: string[] = [];
    const refused = await call(`${DRAFT_HOST}/v1`, seen).catch((err: unknown) => err);
    expect((refused as ProxyCallError).code).toBe("credential_not_found");
    expect((await call(`${DRAFT_HOST}/v1`, seen, { version: DRAFT })).status).toBe(200);
  });

  it("still requires the integration to be active in the space", async () => {
    await seedPackage({
      id: ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifestAuthorizing(DRAFT_HOST),
    });
    await seedProxyConnection(ctx, ID, "api", { api_key: "sk-live" });
    const seen: string[] = [];
    await expect(call(`${DRAFT_HOST}/v1`, seen, { version: DRAFT })).rejects.toThrow(
      "not active in this space",
    );
    expect(seen).toEqual([]);
  });

  it("refuses an override beside a run: the run's frozen version is the only answer", async () => {
    await seedDivergingDraft();
    const seen: string[] = [];
    const run = {
      id: "run_x",
      boundSet: async () => [],
      frozenVersion: async () => null,
    };
    await expect(
      call(`${DRAFT_HOST}/v1`, seen, { reach: undefined, run, version: DRAFT }),
    ).rejects.toThrow("the version the run froze");
    expect(seen).toEqual([]);
  });
});

describe("/api/credential-proxy/proxy never authorizes against the draft", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses a host only the draft authorizes, for the package's own writer", async () => {
    await truncateAll();
    await flushRedis();
    const ctx = await createTestContext({ orgSlug: "cpversion" });
    await seedProxyIntegration(ctx, manifestAuthorizing("https://1.1.1.1"));
    await db
      .update(packages)
      .set({ draftManifest: manifestAuthorizing("https://8.8.8.8") })
      .where(eq(packages.id, ID));
    await seedProxyConnection(ctx, ID, "api", { api_key: "sk-live" });
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["credential-proxy:call-own"],
    });
    let reached = false;
    globalThis.fetch = (async () => {
      reached = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await getTestApp().request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key.rawKey}`,
        "X-Integration-Id": ID,
        "X-Target": "https://8.8.8.8/v1",
        "X-Session-Id": crypto.randomUUID(),
      },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized_target");
    expect(reached).toBe(false);
  });
});
