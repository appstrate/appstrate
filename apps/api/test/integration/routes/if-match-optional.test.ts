// SPDX-License-Identifier: Apache-2.0

/**
 * Every `ifMatchWhere` writer honours an optional `If-Match`: a write under the
 * current ETag lands (200) and moves it, the same stale ETag then gets 412
 * carrying the current one. Schedules and packages have their own tests.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedAgent,
  seedOrgModel,
  seedOrgModelProviderKey,
  seedSpacePackage,
  seedSpaceRole,
} from "../../helpers/seed.ts";
import webhooksModule from "../../../src/modules/webhooks/index.ts";

const app = getTestApp({ modules: [webhooksModule] });

describe("optional If-Match on PATCH", () => {
  let ctx: TestContext;

  const send = (method: string, path: string, body: unknown, ifMatch?: string) =>
    app.request(path, {
      method,
      headers: authHeaders(ctx, {
        "Content-Type": "application/json",
        ...(ifMatch ? { "If-Match": ifMatch } : {}),
      }),
      body: JSON.stringify(body),
    });

  async function created(path: string, body: unknown): Promise<string> {
    const res = await send("POST", path, body);
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  beforeAll(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "ifmatch" });
  });

  // [name, seed → PATCH path, body for the nth write]
  const writers: [string, () => Promise<string>, (n: number) => unknown][] = [
    [
      "proxies",
      async () =>
        `/api/proxies/${await created("/api/proxies", { label: "P", url: "http://proxy.example.com:8080" })}`,
      (n) => ({ label: `P${n}` }),
    ],
    [
      "model-provider credentials",
      async () => {
        const cred = await seedOrgModelProviderKey({ orgId: ctx.orgId, label: "K" });
        return `/api/model-provider-credentials/${cred.id}`;
      },
      (n) => ({ label: `K${n}` }),
    ],
    [
      "models",
      async () => {
        const cred = await seedOrgModelProviderKey({ orgId: ctx.orgId, label: "M" });
        const model = await seedOrgModel({ orgId: ctx.orgId, credentialId: cred.id });
        return `/api/models/${model.id}`;
      },
      (n) => ({ label: `M${n}` }),
    ],
    ["organization", async () => `/api/orgs/${ctx.orgId}`, (n) => ({ name: `Org ${n}` })],
    [
      "org settings",
      async () => `/api/orgs/${ctx.orgId}/settings`,
      (n) => ({ dashboard_sso_enabled: n % 2 === 1 }),
    ],
    ["spaces", async () => `/api/spaces/${ctx.defaultSpaceId}`, (n) => ({ name: `Space ${n}` })],
    [
      "space roles",
      async () => `/api/roles/${(await seedSpaceRole({ orgId: ctx.orgId })).id}`,
      (n) => ({ name: `Role ${n}` }),
    ],
    [
      "space packages",
      async () => {
        const id = "@ifmatch/agent";
        await seedAgent({ id, orgId: ctx.orgId, homeSpaceId: ctx.defaultSpaceId });
        await seedSpacePackage(ctx.defaultSpaceId, id);
        return `/api/spaces/${ctx.defaultSpaceId}/packages/${id}`;
      },
      () => ({ proxyId: null }),
    ],
    [
      "webhooks",
      async () =>
        `/api/webhooks/${await created("/api/webhooks", {
          level: "space",
          spaceId: ctx.defaultSpaceId,
          url: "https://hooks.example/endpoint",
          events: ["run.started"],
        })}`,
      (n) => ({ url: `https://hooks.example/endpoint-${n}` }),
    ],
  ];

  it.each(writers)(
    "%s: 200 under the current ETag, then 412 on the stale one",
    async (_, seed, body) => {
      const path = await seed();
      const read = await send("PATCH", path, body(0));
      expect(read.status).toBe(200);
      const etag = read.headers.get("ETag")!;
      expect(etag).toMatch(/^"\d+"$/);

      // Timestamps are the version: land the write on a later millisecond.
      await Bun.sleep(5);
      const fresh = await send("PATCH", path, body(1), etag);
      expect(fresh.status).toBe(200);
      const current = fresh.headers.get("ETag")!;
      expect(current).not.toBe(etag);

      const stale = await send("PATCH", path, body(2), etag);
      expect(stale.status).toBe(412);
      expect(stale.headers.get("ETag")).toBe(current);
    },
  );
});
