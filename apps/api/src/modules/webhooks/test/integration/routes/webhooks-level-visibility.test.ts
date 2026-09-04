// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/webhooks` spans both scoping levels — `?all=true` returns every
 * row in the org, and the default filter returns the org-level ones — while a
 * single `webhooks:read` guard sits in front of it. That guard alone is not
 * sufficient: a principal holding the space half without the org half
 * (`builder`, once Phase 2 assigns presets) would read org-level webhooks it
 * cannot administer. The route therefore drops the rows whose level the caller
 * cannot read.
 *
 * No org role holds that combination in Phase 1, so the caller is built from a
 * stub auth strategy with a hand-set `permissions` Set — the same technique
 * `apps/api/test/integration/middleware/module-auth-strategy.test.ts` uses.
 * Inventing a role instead would test the role table, not the route.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import type { AppstrateModule, AuthStrategy } from "@appstrate/core/module";
import webhooksModule from "../../../index.ts";

let currentCtx: TestContext | null = null;

/**
 * `X-Test-Perms` carries the caller's permission Set verbatim, so each test
 * names the exact grant it is probing.
 */
const permsStrategy: AuthStrategy = {
  id: "webhook-perms-strategy",
  async authenticate({ headers }) {
    const raw = headers.get("x-test-perms");
    if (!raw) return null;
    if (!currentCtx) throw new Error("currentCtx not seeded — test setup bug");
    return {
      user: {
        id: currentCtx.user.id,
        email: currentCtx.user.email,
        name: currentCtx.user.name,
      },
      orgId: currentCtx.orgId,
      orgSlug: currentCtx.org.slug,
      orgRole: "member",
      authMethod: "webhook-perms-strategy",
      spaceId: currentCtx.defaultSpaceId,
      permissions: raw.split(","),
    };
  },
};

const permsModule: AppstrateModule = {
  manifest: { id: "webhook-perms-stub", name: "Webhook Perms Stub", version: "1.0.0" },
  async init() {},
  authStrategies() {
    return [permsStrategy];
  },
};

const app = getTestApp({ modules: [webhooksModule, permsModule] });

describe("GET /api/webhooks — org-level rows need org-webhooks:read", () => {
  let orgWebhookId: string;
  let spaceWebhookId: string;

  beforeEach(async () => {
    await truncateAll();
    currentCtx = await createTestContext({ orgSlug: "levelvis" });

    // Seeded by the owner (who holds both halves) so the rows exist
    // independently of the permission being probed.
    const org = await app.request("/api/webhooks", {
      method: "POST",
      headers: { ...authHeaders(currentCtx), "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "org",
        url: "https://example.com/org",
        events: ["run.success"],
      }),
    });
    expect(org.status).toBe(201);
    orgWebhookId = ((await org.json()) as { id: string }).id;

    const space = await app.request("/api/webhooks", {
      method: "POST",
      headers: { ...authHeaders(currentCtx), "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "space",
        spaceId: currentCtx.defaultSpaceId,
        url: "https://example.com/space",
        events: ["run.success"],
      }),
    });
    expect(space.status).toBe(201);
    spaceWebhookId = ((await space.json()) as { id: string }).id;
  });

  async function listWith(perms: string): Promise<string[]> {
    const res = await app.request("/api/webhooks?all=true", {
      headers: { "X-Test-Perms": perms },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { id: string }[] }).data.map((w) => w.id);
  }

  it("webhooks:read alone sees the space row and NOT the org row", async () => {
    const ids = await listWith("webhooks:read");
    expect(ids).toContain(spaceWebhookId);
    expect(ids).not.toContain(orgWebhookId);
  });

  it("adding org-webhooks:read reveals the org row (control)", async () => {
    // The discriminating half: the same request, the same rows, one extra
    // permission. Without it the assertion above could pass because the org
    // row was never created or never listed.
    const ids = await listWith("webhooks:read,org-webhooks:read");
    expect(ids).toContain(spaceWebhookId);
    expect(ids).toContain(orgWebhookId);
  });

  it("the default (no ?all) listing is empty without org-webhooks:read", async () => {
    // The default filter returns ONLY org-level rows, so a space-half-only
    // caller legitimately sees nothing rather than another level's data.
    const res = await app.request("/api/webhooks", {
      headers: { "X-Test-Perms": "webhooks:read" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("no webhooks:read at all is a 403, not an empty page", async () => {
    const res = await app.request("/api/webhooks?all=true", {
      headers: { "X-Test-Perms": "org-webhooks:read" },
    });
    expect(res.status).toBe(403);
  });

  it("a caller with no webhook permission cannot use 404-vs-403 as an existence oracle", async () => {
    // The by-id routes must read the row before they can know its level, so
    // without the guard in `loadWebhookForAction` a permission-less caller
    // would get 404 for an unknown id and 403 for a real one.
    const real = await app.request(`/api/webhooks/${orgWebhookId}`, {
      headers: { "X-Test-Perms": "runs:read" },
    });
    const fake = await app.request("/api/webhooks/wh_00000000-0000-0000-0000-000000000000", {
      headers: { "X-Test-Perms": "runs:read" },
    });
    expect(real.status).toBe(403);
    expect(fake.status).toBe(403);
  });

  it("a reader still gets 404 for an id that does not exist", async () => {
    // Control: the 403 above is about the caller, not about every miss —
    // someone allowed to read webhooks keeps the honest not-found.
    const res = await app.request("/api/webhooks/wh_00000000-0000-0000-0000-000000000000", {
      headers: { "X-Test-Perms": "webhooks:read,org-webhooks:read" },
    });
    expect(res.status).toBe(404);
  });
});
