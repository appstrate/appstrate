// SPDX-License-Identifier: Apache-2.0

/**
 * A credential bound to a SET of spaces (`AuthResolution.spaceIds`, here the chat's MCP loopback
 * bearer) refuses a space it may not name the same way everywhere:
 *
 *   - it gets the 404 a missing space gets (`enterSpaceById`), on the path guard
 *     (`pinnedSpaceScopeGuard`), on the share-target check and through the MCP dispatch,
 *     though its org permissions would serve the space;
 *   - a pinned credential keeps its 403 (asserted by `spaces.test.ts`);
 *   - a confined credential addressing a PERSON in a share is refused before the directory is
 *     read, so a member and a non-member answer alike, and no personal space is provisioned.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spacePackages, spaces } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import { loopbackHeaders } from "../../helpers/loopback.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../helpers/mcp.ts";
import { registerTestPlatformApp } from "../../helpers/platform-app.ts";
import { orgPermissions, presetPermissions } from "../../../src/lib/permissions.ts";
import { ensurePersonalSpaceFor } from "../../../src/services/spaces.ts";

const app = getTestApp();
await registerTestPlatformApp();

let ctx: TestContext;
let homeId: string;
let otherId: string;

const AGENT = "@allow/worker";
const MISSING_SPACE = "spc_00000000-0000-4000-8000-000000000000";

/** The problem body without the per-request ids, `id` replaced by a placeholder. */
async function problemOf(res: Response, id?: string): Promise<Record<string, unknown>> {
  const { instance: _i, request_id: _r, ...rest } = (await res.json()) as Record<string, unknown>;
  return id ? (JSON.parse(JSON.stringify(rest).replaceAll(id, "ID")) as typeof rest) : rest;
}

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

/** The org owner's bearer allowlisting `spaceIds`: its org permissions span every space. */
const allowlisted = (spaceIds: string[]) => ({
  ...loopbackHeaders(ctx, ctx.orgId, {
    orgRole: "owner",
    permissions: [...orgPermissions("owner"), ...presetPermissions("admin"), "mcp:read"],
    spaceIds,
  }),
  "X-Space-Id": homeId,
});

const placements = async (packageId: string) =>
  (
    await db
      .select({ spaceId: spacePackages.spaceId })
      .from(spacePackages)
      .where(eq(spacePackages.packageId, packageId))
  )
    .map((row) => row.spaceId)
    .sort();

describe("a space outside an allowlist", () => {
  it("GET /api/spaces/:id answers what a nonexistent space gets", async () => {
    const outside = await app.request(`/api/spaces/${otherId}`, { headers: allowlisted([homeId]) });
    const missing = await app.request(`/api/spaces/${MISSING_SPACE}`, {
      headers: allowlisted([homeId]),
    });
    expect(outside.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await problemOf(outside, otherId)).toEqual(await problemOf(missing, MISSING_SPACE));
  });

  it("GET /api/spaces/:id inside the allowlist is served (control)", async () => {
    const res = await app.request(`/api/spaces/${homeId}`, { headers: allowlisted([homeId]) });
    expect(res.status).toBe(200);
  });

  it("DELETE …/shares/:space is a 404 and withdraws nothing, though the caller governs the home", async () => {
    await seedSpacePackage(otherId, AGENT);
    const res = await app.request(`/api/packages/${AGENT}/shares/${otherId}`, {
      method: "DELETE",
      headers: allowlisted([homeId]),
    });
    expect(res.status).toBe(404);
    expect(await placements(AGENT)).toEqual([homeId, otherId].sort());
  });

  it("is named in no path through the MCP dispatch, and the listing holds the allowlist alone", async () => {
    // The MCP endpoint reads no `X-Space-Id`: every call names its space.
    const { "X-Space-Id": _space, ...headers } = allowlisted([homeId]);
    let nextId = 1;
    const invoke = async (operationId: string, pathParams?: Record<string, string>) => {
      const res = await app.request(`/api/mcp/o/${ctx.orgId}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: {
            name: "invoke_operation",
            arguments: {
              operation_id: operationId,
              space_id: homeId,
              ...(pathParams ? { path_params: pathParams } : {}),
            },
          },
        }),
      });
      const envelope = (await res.json()) as JsonRpcEnvelope;
      const content = (envelope.result?.content as Array<{ text: string }>) ?? [];
      return JSON.parse(content[0]!.text) as { status: number; body: unknown };
    };

    for (const operationId of [
      "getSpace",
      "deleteSpace",
      "convertSpaceToTeam",
      "sweepPersonalSpace",
      "listSpaceMembers",
      "listSpacePackages",
    ]) {
      const refused = await invoke(operationId, { id: otherId });
      expect({ operationId, status: refused.status }).toEqual({ operationId, status: 404 });
    }
    expect((await invoke("getSpace", { id: homeId })).status).toBe(200);
    const listed = await invoke("listSpaces");
    expect((listed.body as { data: Array<{ id: string }> }).data.map((row) => row.id)).toEqual([
      homeId,
    ]);
    // Still there: the delete never ran.
    expect(await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, otherId))).toEqual([
      { id: otherId },
    ]);
  });
});

describe("POST …/shares with a person target and a confined credential", () => {
  const share = (userId: string) =>
    app.request(`/api/packages/${AGENT}/shares`, {
      method: "POST",
      headers: { ...allowlisted([homeId]), "Content-Type": "application/json" },
      body: JSON.stringify({ target: { kind: "user", userId } }),
    });
  const personalSpacesOf = (userId: string) =>
    db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.orgId, ctx.orgId), eq(spaces.ownerUserId, userId)));

  it("answers a member and a stranger identically, before any directory read", async () => {
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    const stranger = await createTestUser();

    const asMember = await share(member.id);
    const asStranger = await share(stranger.id);
    const unknown = await share("00000000-0000-4000-8000-000000000000");

    expect(asMember.status, await asMember.clone().text()).toBe(403);
    const bodies = await Promise.all([asMember, asStranger, unknown].map((res) => problemOf(res)));
    expect(asStranger.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it("provisions no personal space, and places nothing in one already provisioned", async () => {
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");

    expect((await share(member.id)).status).toBe(403);
    expect(await personalSpacesOf(member.id)).toEqual([]);

    await ensurePersonalSpaceFor(ctx.orgId, member.id);
    expect((await share(member.id)).status).toBe(403);
    expect(await placements(AGENT)).toEqual([homeId]);
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
