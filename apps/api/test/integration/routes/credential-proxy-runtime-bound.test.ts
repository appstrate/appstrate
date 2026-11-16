// SPDX-License-Identifier: Apache-2.0
/**
 * An integration bound to the runtime (`@appstrate/platform`, the shipped system package) outside
 * a run: active in every space without a row, remote, without auths, its declared URL a
 * placeholder. Its tools exist only for a run, so the credential proxy's outside-run paths
 * neither list it nor call it, and nothing reaches its declared server.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { connectionCalls } from "@appstrate/db/schema";
import { clearAllCachesLocally } from "@appstrate/core/cache";
import { PLATFORM_INTEGRATION_ID } from "@appstrate/core/integration";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { installRuntimeBoundSystemPackages } from "../../helpers/runtime-bound-system-packages.ts";
import { isIntegrationActive } from "../../../src/services/integration-connections.ts";

const OFFERS = { "X-Appstrate-Connect-Offers": "1" };

describe("a runtime-bound integration outside a run", () => {
  let ctx: TestContext;
  let apiKey: string;
  let restoreRegistry: () => void;
  let fetched: string[];
  let realFetch: typeof fetch;

  const headers = (extra: Record<string, string> = {}) => ({
    ...extra,
    Authorization: `Bearer ${apiKey}`,
    "X-Org-Id": ctx.orgId,
    "X-Space-Id": ctx.defaultSpaceId,
  });

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    clearAllCachesLocally();
    restoreRegistry = await installRuntimeBoundSystemPackages();
    ctx = await createTestContext({ orgSlug: "acme" });
    apiKey = (
      await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["credential-proxy:call-own", "integrations:connect"],
      })
    ).rawKey;
    fetched = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      fetched.push(input instanceof Request ? input.url : String(input));
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreRegistry();
  });

  /** No exchange was attempted with its server, and no call journaled. */
  const expectServerUntouched = async () => {
    expect(fetched.filter((url) => url.includes("platform.appstrate.invalid"))).toEqual([]);
    expect(await db.select().from(connectionCalls)).toEqual([]);
  };

  /** A refusal naming it as an integration that is not active in the space. */
  const expectInactive = async (res: Response) => {
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      code: "not_found",
      detail: `Integration '${PLATFORM_INTEGRATION_ID}' is not active in this space`,
    });
  };

  it("is active in the space: excluding it is the outside-run paths' own rule", async () => {
    expect(await isIntegrationActive(PLATFORM_INTEGRATION_ID, ctx.defaultSpaceId)).toBe(true);
  });

  it("is absent from the tool listing: no tool, connection, not-ready or unlisted entry", async () => {
    for (const query of ["", "?name=appstrate_platform__log"]) {
      const res = await getTestApp().request(`/api/credential-proxy/tools${query}`, {
        headers: headers(OFFERS),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        tools: [],
        connections: [],
        not_ready: [],
        unlisted: [],
        truncated_catalogs: [],
      });
    }
    await expectServerUntouched();
  });

  it("refuses a listing filtered on it as an integration that is not active", async () => {
    const query = new URLSearchParams({ integration_package_id: PLATFORM_INTEGRATION_ID });
    await expectInactive(
      await getTestApp().request(`/api/credential-proxy/tools?${query.toString()}`, {
        headers: headers(),
      }),
    );
    await expectServerUntouched();
  });

  it("is absent from the connections a call outside a run reaches", async () => {
    const res = await getTestApp().request("/api/credential-proxy/connections", {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("refuses a tool call naming it as an integration that is not active, before any exchange", async () => {
    const res = await getTestApp().request("/api/credential-proxy/tools/call", {
      method: "POST",
      headers: { ...headers(OFFERS), "Content-Type": "application/json" },
      body: JSON.stringify({
        integration_package_id: PLATFORM_INTEGRATION_ID,
        name: "log",
        arguments: { message: "hello" },
      }),
    });
    await expectInactive(res);
    await expectServerUntouched();
  });

  it("refuses a server sync of it: a system package is not the caller's to write", async () => {
    const res = await getTestApp().request(
      `/api/integrations/${PLATFORM_INTEGRATION_ID}/discover`,
      { method: "POST", headers: authHeaders(ctx, { "Content-Type": "application/json" }) },
    );
    expect(res.status).toBe(403);
    await expectServerUntouched();
  });
});
