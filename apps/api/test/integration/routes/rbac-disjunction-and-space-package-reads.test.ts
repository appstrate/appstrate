// SPDX-License-Identifier: Apache-2.0

/**
 * Three refusals held level with the route beside them.
 *
 *  1. `GET /api/spaces/:id/packages/:scope/:name` gates on `spaces:read` only,
 *     while the sibling list filters each row by its package type. The pair is
 *     pinned together here: whatever the list hides, the by-id route hides too.
 *  2. A disjunction denial ("hold any one of these") records the alternatives,
 *     not one arbitrary member of the list.
 *  3. The SSE stream answers a non-member of a closed space the way the HTTP
 *     pipeline does, instead of 401 "log in again" for a live session.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  setPermissionDenialHandler,
  type PermissionDenialContext,
} from "@appstrate/core/permissions";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedInstalledPackage,
  seedMcpServer,
  seedSpace,
  seedSpaceMember,
  seedSpaceRole,
} from "../../helpers/seed.ts";

const app = getTestApp();
const MCP_ID = "@catalog/hidden-server";

let ctx: TestContext;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "rbac-disjunction" });
});

describe("space package detail follows the list's visibility", () => {
  interface SpacePackageList {
    data: { packageId: string }[];
  }

  async function memberHolding(permissions: string[]) {
    const member = await memberContext(ctx, "guest");
    const role = await seedSpaceRole({ orgId: ctx.orgId, permissions });
    await seedSpaceMember({
      spaceId: ctx.defaultSpaceId,
      userId: member.user.id,
      presetRole: null,
      customRoleId: role.id,
    });
    return authHeaders(member);
  }

  beforeEach(async () => {
    await seedMcpServer({ id: MCP_ID, orgId: ctx.orgId });
    await seedInstalledPackage(ctx.defaultSpaceId, MCP_ID);
  });

  it("hides an mcp-server row from a role holding only agents:read, in the list AND by id", async () => {
    const headers = await memberHolding(["agents:read"]);

    const list = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages`, { headers });
    expect(list.status).toBe(200);
    expect(((await list.json()) as SpacePackageList).data).toEqual([]);

    const byId = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages/${MCP_ID}`, {
      headers,
    });
    expect(byId.status).toBe(404);
    expect(await byId.json()).toMatchObject({ code: "package_not_installed" });
  });

  it("serves the same row to a role that does hold mcp-servers:read", async () => {
    const headers = await memberHolding(["agents:read", "mcp-servers:read"]);

    const list = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages`, { headers });
    expect(((await list.json()) as SpacePackageList).data.map((row) => row.packageId)).toEqual([
      MCP_ID,
    ]);

    const byId = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages/${MCP_ID}`, {
      headers,
    });
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject({ packageId: MCP_ID });
  });
});

describe("a disjunction denial records every alternative", () => {
  const denials: string[] = [];

  beforeEach(() => {
    denials.length = 0;
    setPermissionDenialHandler((denial: PermissionDenialContext) => {
      denials.push(denial.required);
    });
  });

  afterEach(() => setPermissionDenialHandler(null));

  it("names all four write scopes when an import is refused, not just the first", async () => {
    const viewer = await memberContext(ctx, "guest", "viewer");

    const refused = await app.request("/api/packages/import-github", {
      method: "POST",
      headers: authHeaders(viewer, { "Content-Type": "application/json" }),
      body: JSON.stringify({ url: "https://github.com/appstrate/example" }),
    });

    expect(refused.status).toBe(403);
    expect(denials).toEqual(["agents:write|skills:write|integrations:write|mcp-servers:write"]);
  });
});

describe("SSE refuses a non-member the way the HTTP pipeline does", () => {
  it("answers 403 on a closed space and 404 on a private one, with no persona", async () => {
    const outsider = await memberContext(ctx, "member");

    const closed = await seedSpace({
      orgId: ctx.orgId,
      name: "SSE closed",
      visibility: "closed",
    });
    const secret = await seedSpace({
      orgId: ctx.orgId,
      name: "SSE private",
      visibility: "private",
    });

    const closedRes = await app.request(
      `/api/realtime/runs?orgId=${ctx.orgId}&spaceId=${closed.id}`,
      { headers: { Cookie: outsider.cookie, Accept: "text/event-stream" } },
    );
    expect(closedRes.status).toBe(403);
    expect(await closedRes.json()).toMatchObject({ code: "not_a_space_member" });

    const privateRes = await app.request(
      `/api/realtime/runs?orgId=${ctx.orgId}&spaceId=${secret.id}`,
      { headers: { Cookie: outsider.cookie, Accept: "text/event-stream" } },
    );
    expect(privateRes.status).toBe(404);
  });
});
