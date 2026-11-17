// SPDX-License-Identifier: Apache-2.0

/**
 * A credential bound to a SET of spaces (`AuthResolution.spaceIds`, here the chat's MCP loopback
 * bearer) that asks for a space webhook outside its set is told what a nonexistent id is told:
 * the same 404, naming no space. An org-level webhook fires for every space, so such a credential
 * neither creates, lists nor reaches one, whatever its org permissions.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../../../../test/helpers/auth.ts";
import { seedSpace } from "../../../../../../test/helpers/seed.ts";
import { loopbackHeaders } from "../../../../../../test/helpers/loopback.ts";
import { orgPermissions, presetPermissions } from "../../../../../lib/permissions.ts";
import { seedWebhook } from "../../helpers/seed.ts";

const app = getTestApp();

let ctx: TestContext;
let outsideId: string;
let outsideSpaceId: string;
let insideId: string;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "whallow" });
  outsideSpaceId = (await seedSpace({ orgId: ctx.orgId, name: "Outside", visibility: "closed" }))
    .id;
  outsideId = (await seedWebhook({ orgId: ctx.orgId, spaceId: outsideSpaceId })).id;
  insideId = (await seedWebhook({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId })).id;
});

/** The org owner's bearer allowlisting the default space: its org permissions span every space. */
const allowlisted = () =>
  loopbackHeaders(ctx, ctx.orgId, {
    orgRole: "owner",
    permissions: [...orgPermissions("owner"), ...presetPermissions("admin")],
    spaceIds: [ctx.defaultSpaceId],
  });

const headers = () => ({ ...allowlisted(), "X-Space-Id": ctx.defaultSpaceId });

describe("by-id webhook routes under a space allowlist", () => {
  for (const [method, label] of [
    ["GET", "read"],
    ["PATCH", "update"],
    ["DELETE", "delete"],
  ] as const) {
    it(`${label}: a webhook outside the set answers what a nonexistent id gets, ids aside`, async () => {
      const call = (id: string) =>
        app.request(`/api/webhooks/${id}`, {
          method,
          headers: { ...headers(), "Content-Type": "application/json" },
          body: method === "PATCH" ? JSON.stringify({ enabled: false }) : undefined,
        });
      const outside = await call(outsideId);
      const missing = await call("wh_doesnotexist0000");
      expect(outside.status, await outside.clone().text()).toBe(404);
      expect(missing.status).toBe(404);
      const outsideBody = (await outside.json()) as { detail: string };
      const missingBody = (await missing.json()) as { detail: string };
      expect(outsideBody.detail).toBe(`Webhook '${outsideId}' not found`);
      expect(missingBody.detail).toBe("Webhook 'wh_doesnotexist0000' not found");
      expect(JSON.stringify(outsideBody)).not.toContain(outsideSpaceId);
      // Same body once the echoed id and the per-request ids are normalized.
      const normalized = (body: object, id: string) =>
        JSON.stringify(body)
          .replaceAll(id, "ID")
          .replace(/req_[0-9a-f-]+/g, "REQ");
      expect(normalized(outsideBody, outsideId)).toBe(
        normalized(missingBody, "wh_doesnotexist0000"),
      );
    });
  }

  it("a webhook inside the set is read (control)", async () => {
    const res = await app.request(`/api/webhooks/${insideId}`, { headers: headers() });
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

describe("org-level webhooks under a space allowlist", () => {
  it("manages none, though its org permissions hold org-webhooks:*", async () => {
    const json = { "Content-Type": "application/json" };
    const session = { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId, ...json };
    const orgHook = JSON.stringify({
      level: "org",
      url: "https://example.com/org",
      events: ["run.success"],
    });
    const created = await app.request("/api/webhooks", {
      method: "POST",
      headers: session,
      body: orgHook,
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const confined = { ...allowlisted(), ...json };
    const call = (path: string, method = "GET", body?: string) =>
      app.request(path, { method, headers: confined, ...(body ? { body } : {}) });

    expect((await call("/api/webhooks", "POST", orgHook)).status).toBe(403);
    expect((await call("/api/webhooks?all=true")).status).toBe(403);
    const listed = (await (await call("/api/webhooks")).json()) as { data: Array<{ id: string }> };
    expect(listed.data.map((row) => row.id)).not.toContain(id);
    // By id it is not there for it, whatever the action.
    for (const [path, method, body] of [
      [`/api/webhooks/${id}`, "GET"],
      [`/api/webhooks/${id}`, "PATCH", JSON.stringify({ enabled: false })],
      [`/api/webhooks/${id}/rotate`, "POST"],
      [`/api/webhooks/${id}/test`, "POST"],
      [`/api/webhooks/${id}/deliveries`, "GET"],
      [`/api/webhooks/${id}`, "DELETE"],
    ] as const) {
      expect({ path, method, status: (await call(path, method, body)).status }).toEqual({
        path,
        method,
        status: 404,
      });
    }
    const still = await app.request(`/api/webhooks/${id}`, { headers: session });
    expect(((await still.json()) as { enabled: boolean }).enabled).toBe(true);
  });
});
