// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC on the agent-config + space-package READ surface.
 *
 * Five GETs shipped without the `requirePermission` guard their siblings
 * carry: the agent list, `…/proxy`, `…/model`, and the two
 * `/api/spaces/:spaceId/packages` reads. The `router.use` guards on the
 * spaces router only prove the space belongs to the org — org ownership is
 * not authorization.
 *
 * The scoped API key is the only credential that can express "authenticated
 * for this org, WITHOUT `agents:read`" (or without `spaces:read`): every org
 * role down to `viewer` carries both, which is exactly why the gap was
 * invisible from the SPA. Each negative case therefore hands the key the
 * OTHER resource's read scope — that keeps the credential valid and proves
 * the guard selects a resource rather than accepting any scope at all.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage, seedApiKey } from "../../helpers/seed.ts";

const app = getTestApp();

const AGENT_ID = "@testorg/config-read-agent";

interface Route {
  label: string;
  path: string;
}

/** The three routes gated on `agents:read`. */
function agentReadRoutes(): Route[] {
  return [
    { label: "agents list", path: "/api/agents" },
    { label: "agent proxy", path: `/api/agents/${AGENT_ID}/proxy` },
    { label: "agent model", path: `/api/agents/${AGENT_ID}/model` },
  ];
}

/** The two routes gated on `spaces:read`. */
function spacePackageReadRoutes(spaceId: string): Route[] {
  return [
    { label: "space packages list", path: `/api/spaces/${spaceId}/packages` },
    { label: "space package detail", path: `/api/spaces/${spaceId}/packages/${AGENT_ID}` },
  ];
}

describe("agent-config + space-package GET routes — read permission", () => {
  let ctx: TestContext;

  async function keyWithScopes(scopes: string[]): Promise<string> {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes,
    });
    return key.rawKey;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
    await seedPackage({
      id: AGENT_ID,
      type: "agent",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT_ID,
        version: "0.1.0",
        type: "agent",
        description: "Guarded agent",
      },
    });
    await seedInstalledPackage(ctx.defaultSpaceId, AGENT_ID);
  });

  it("403s the agent-config GETs for a key without agents:read", async () => {
    const rawKey = await keyWithScopes(["spaces:read"]);

    for (const route of agentReadRoutes()) {
      const res = await app.request(route.path, {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 403`);
      // The list inlines every manifest; a status assertion alone would not
      // prove the body stayed shut.
      expect(await res.text()).not.toContain("Guarded agent");
    }
  });

  it("serves the agent-config GETs once the key holds agents:read", async () => {
    const rawKey = await keyWithScopes(["agents:read"]);

    for (const route of agentReadRoutes()) {
      const res = await app.request(route.path, {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 200`);
    }
  });

  it("403s the space-package GETs for a key without spaces:read", async () => {
    const rawKey = await keyWithScopes(["agents:read"]);

    for (const route of spacePackageReadRoutes(ctx.defaultSpaceId)) {
      const res = await app.request(route.path, {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 403`);
      expect(await res.text()).not.toContain("Guarded agent");
    }
  });

  it("serves the space-package GETs once the key holds spaces:read", async () => {
    const rawKey = await keyWithScopes(["spaces:read"]);

    for (const route of spacePackageReadRoutes(ctx.defaultSpaceId)) {
      const res = await app.request(route.path, {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 200`);
    }
  });

  it("denies before resolving the agent, so a denial is not an existence oracle", async () => {
    // `requireAgent()` 404s on an unknown agent. Registered first it would
    // answer "that agent does not exist" to a caller with no read scope at
    // all — the guard order is what makes both answers 403 here.
    const rawKey = await keyWithScopes(["spaces:read"]);

    for (const path of [
      `/api/agents/${AGENT_ID}/proxy`,
      "/api/agents/@testorg/no-such-agent/proxy",
      `/api/agents/${AGENT_ID}/model`,
      "/api/agents/@testorg/no-such-agent/model",
    ]) {
      const res = await app.request(path, { headers: { Authorization: `Bearer ${rawKey}` } });
      expect(`${path}: ${res.status}`).toBe(`${path}: 403`);
    }
  });

  it("keeps a plain member session at 200 on all five routes", async () => {
    // The fix must not move the common path: `member` holds `agents:read`
    // and `spaces:read`, and neither route family is admin-grade.
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    const headers = {
      Cookie: member.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Space-Id": ctx.defaultSpaceId,
    };

    for (const route of [...agentReadRoutes(), ...spacePackageReadRoutes(ctx.defaultSpaceId)]) {
      const res = await app.request(route.path, { headers });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 200`);
    }
  });
});
