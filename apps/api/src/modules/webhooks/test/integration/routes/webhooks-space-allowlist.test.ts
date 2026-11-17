// SPDX-License-Identifier: Apache-2.0

/**
 * A credential bound to a SET of spaces (`AuthResolution.spaceIds`, the chat's MCP bearer) that
 * asks for a space webhook outside its set is told what a nonexistent id is told: the same 404,
 * naming no space.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../../../../test/helpers/auth.ts";
import { seedSpace } from "../../../../../../test/helpers/seed.ts";
import type { AppstrateModule, AuthStrategy } from "@appstrate/core/module";
import webhooksModule from "../../../index.ts";
import { seedWebhook } from "../../helpers/seed.ts";

let ctx: TestContext;

const strategy: AuthStrategy = {
  id: "webhook-allowlist-stub",
  async authenticate({ headers }) {
    const raw = headers.get("x-test-space-ids");
    if (raw === null) return null;
    return {
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name },
      orgId: ctx.orgId,
      orgSlug: ctx.org.slug,
      orgRole: "owner",
      authMethod: "webhook-allowlist-stub",
      principalKind: "user",
      permissions: ["webhooks:read", "webhooks:write", "webhooks:delete"],
      spaceIds: raw.split(","),
    };
  },
};

const stubModule: AppstrateModule = {
  manifest: { id: "webhook-allowlist-stub", name: "Webhook Allowlist Stub", version: "1.0.0" },
  async init() {},
  authStrategies() {
    return [strategy];
  },
};

const app = getTestApp({ modules: [webhooksModule, stubModule] });

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

const headers = () => ({
  "X-Test-Space-Ids": ctx.defaultSpaceId,
  "X-Space-Id": ctx.defaultSpaceId,
});

describe("by-id webhook routes under a space allowlist", () => {
  for (const [method, label] of [
    ["GET", "read"],
    ["PATCH", "update"],
    ["DELETE", "delete"],
  ] as const) {
    it(`${label}: a webhook outside the set is byte-identical to a nonexistent id`, async () => {
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
