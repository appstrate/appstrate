// SPDX-License-Identifier: Apache-2.0

/**
 * A credential bound to a SET of spaces (`AuthResolution.spaceIds`, the chat's MCP bearer) and
 * a credential pinned to ONE space refuse a space they may not name the same way everywhere:
 *
 *   - an allowlisted credential gets the 404 a missing space gets (`enterSpaceById`), on the path
 *     guard (`pinnedSpaceScopeGuard`) and on the share-target check;
 *   - a pinned credential keeps its 403 (asserted by `spaces.test.ts`);
 *   - a confined credential addressing a PERSON in a share is refused before the directory is read,
 *     so a member and a non-member answer alike.
 */

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedPackage, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import type { AppstrateModule, AuthStrategy } from "@appstrate/core/module";

let ctx: TestContext;

/** `X-Test-Space-Ids` (comma list) is the allowlist the stub credential carries. */
const strategy: AuthStrategy = {
  id: "space-allowlist-stub",
  async authenticate({ headers }) {
    const raw = headers.get("x-test-space-ids");
    if (raw === null) return null;
    return {
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name },
      orgId: ctx.orgId,
      orgSlug: ctx.org.slug,
      orgRole: "owner",
      authMethod: "space-allowlist-stub",
      principalKind: "user",
      permissions: [
        "agents:read",
        "agents:share",
        "members:read",
        "spaces:read",
        "spaces:write",
        "space-settings:write",
      ],
      spaceIds: raw === "" ? [] : raw.split(","),
    };
  },
};

const stubModule: AppstrateModule = {
  manifest: { id: "space-allowlist-stub", name: "Space Allowlist Stub", version: "1.0.0" },
  async init() {},
  authStrategies() {
    return [strategy];
  },
};

const app = getTestApp({ modules: [stubModule] });

const AGENT = "@allow/worker";

/** The problem body without the per-request ids. */
async function problemOf(res: Response): Promise<Record<string, unknown>> {
  const { instance: _i, request_id: _r, ...rest } = (await res.json()) as Record<string, unknown>;
  return rest;
}
let homeId: string;
let otherId: string;

beforeAll(() => {
  // Nothing to build once: every case seeds its own rows.
});

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "allow" });
  homeId = ctx.defaultSpaceId;
  otherId = (await seedSpace({ orgId: ctx.orgId, name: "Other", visibility: "closed" })).id;
  await seedPackage({
    id: AGENT,
    orgId: ctx.orgId,
    type: "agent",
    homeSpaceId: homeId,
    createdBy: ctx.user.id,
    draftManifest: { name: AGENT, version: "0.1.0", type: "agent", description: "Worker" },
    draftContent: "Do the thing.",
  });
  await seedSpacePackage(homeId, AGENT);
});

const allowlisted = (spaceIds: string[]) => ({
  "X-Test-Space-Ids": spaceIds.join(","),
  "X-Space-Id": homeId,
});

describe("a space outside an allowlist", () => {
  it("GET /api/spaces/:id is a 404, the answer a nonexistent space gets", async () => {
    const outside = await app.request(`/api/spaces/${otherId}`, { headers: allowlisted([homeId]) });
    const missing = await app.request("/api/spaces/spc_00000000-0000-4000-8000-000000000000", {
      headers: allowlisted([homeId]),
    });
    expect(outside.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it("GET /api/spaces/:id inside the allowlist is served (control)", async () => {
    const res = await app.request(`/api/spaces/${homeId}`, { headers: allowlisted([homeId]) });
    expect(res.status).toBe(200);
  });

  it("DELETE …/shares/:space is a 404", async () => {
    const res = await app.request(`/api/packages/${AGENT}/shares/${otherId}`, {
      method: "DELETE",
      headers: allowlisted([homeId]),
    });
    expect(res.status).toBe(404);
  });
});

describe("a space pinned credential keeps its 403", () => {
  it("GET /api/spaces/:otherId", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: homeId,
      createdBy: ctx.user.id,
      scopes: ["spaces:read"],
    });
    const res = await app.request(`/api/spaces/${otherId}`, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("POST …/shares with a person target and a confined credential", () => {
  const share = (userId: string) =>
    app.request(`/api/packages/${AGENT}/shares`, {
      method: "POST",
      headers: { ...allowlisted([homeId]), "Content-Type": "application/json" },
      body: JSON.stringify({ target: { kind: "user", userId } }),
    });

  it("answers a member and a stranger identically, before any directory read", async () => {
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    const stranger = await createTestUser();

    const asMember = await share(member.id);
    const asStranger = await share(stranger.id);
    const unknown = await share("00000000-0000-4000-8000-000000000000");

    expect(asMember.status, await asMember.clone().text()).toBe(403);
    const bodies = await Promise.all([asMember, asStranger, unknown].map(problemOf));
    expect(asStranger.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it("DELETE …/shares/:userId answers a member and a stranger identically", async () => {
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    const stranger = await createTestUser();
    const del = (userId: string) =>
      app.request(`/api/packages/${AGENT}/shares/${userId}`, {
        method: "DELETE",
        headers: allowlisted([homeId]),
      });
    const a = await del(member.id);
    const b = await del(stranger.id);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect(await problemOf(b)).toEqual(await problemOf(a));
  });
});
