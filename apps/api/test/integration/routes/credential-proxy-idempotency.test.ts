// SPDX-License-Identifier: Apache-2.0

/**
 * `Idempotency-Key` on `/api/credential-proxy/proxy` is the upstream's: the proxy relays it with
 * the caller's other headers and the platform makes no promise about it. The mount opens that
 * one route: a sibling route of the same router keeps the guard's refusal.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import {
  seedProxyConnection,
  seedProxyIntegration,
} from "../../helpers/credential-proxy-fixtures.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";
import { errorHandler } from "../../../src/middleware/error-handler.ts";
import { relayIdempotencyKey } from "../../../src/middleware/idempotency.ts";
import { idempotencyGuard } from "../../../src/middleware/idempotency-guard.ts";
import type { AppEnv } from "../../../src/types/index.ts";

const app = getTestApp();

const INTEGRATION_ID = "@idemproxy/payments";

// The route reaches the upstream through `globalThis.fetch`; the real one is pinned once.
const realFetch: typeof fetch = globalThis.fetch;

describe("Idempotency-Key through the credential proxy", () => {
  let ctx: TestContext;
  let apiKey: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "idemproxy" });
    await seedProxyIntegration(
      ctx,
      localIntegrationManifest({
        name: INTEGRATION_ID,
        auths: {
          api: {
            type: "api_key",
            authorizedUris: ["https://1.1.1.1/**"],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "api_key",
            }),
          },
        },
      }),
    );
    await seedProxyConnection(ctx, INTEGRATION_ID, "api", { api_key: "sk-test" });
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["credential-proxy:direct"],
    });
    apiKey = key.rawKey;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("relays the caller's Idempotency-Key to the upstream", async () => {
    let sent: Headers | null = null;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const res = await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://1.1.1.1/v1/charges",
        "X-Session-Id": crypto.randomUUID(),
        "Content-Type": "application/json",
        "Idempotency-Key": "charge-42",
      },
      body: JSON.stringify({ amount: 100 }),
    });

    expect(res.status).toBe(200);
    expect(sent!.get("idempotency-key")).toBe("charge-42");
    // The platform de-duplicated nothing: no replay marker of its own.
    expect(res.headers.get("Idempotent-Replayed")).toBeNull();
  });
});

describe("relayIdempotencyKey — the mount the guard reads", () => {
  /** Guard → a sub-router mounting the marker on one path only, as the proxy router does. */
  function buildApp() {
    const sub = new Hono<AppEnv>();
    sub.use("/proxy", relayIdempotencyKey());
    sub.all("/proxy", (c) => c.json({ key: c.req.header("Idempotency-Key") ?? null }));
    sub.post("/other", (c) => c.json({ ok: true }));

    const parent = new Hono<AppEnv>();
    parent.onError(errorHandler);
    parent.use("*", idempotencyGuard());
    parent.route("/api/relay", sub);
    return parent;
  }

  const post = (path: string) =>
    buildApp().request(path, { method: "POST", headers: { "Idempotency-Key": "k-1" } });

  it("lets the header through on the route that relays it", async () => {
    const res = await post("/api/relay/proxy");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "k-1" });
  });

  it("refuses it on a sibling route of the same router", async () => {
    const res = await post("/api/relay/other");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("idempotency_not_supported");
  });
});
