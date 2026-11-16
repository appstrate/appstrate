// SPDX-License-Identifier: Apache-2.0

/**
 * An organization session's loopback bearer against the REAL organization MCP
 * endpoint (`/api/mcp/o/:org`).
 *
 * The bearer is a CEILING, not a grant: its permission list is the union of the
 * caller's effective sets over every space they reach, and each space entry
 * recomputes `(org ∪ role in that space) ∩ ceiling`. So a permission held in one
 * space is in the list and still cannot act in another where the caller's role
 * lacks it. The caller here is `operator` in the default space, `admin` in
 * "Gestion" and `viewer` in "Lecture".
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  memberContext,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { seedSpace, seedSpaceMember } from "../../../apps/api/test/helpers/seed.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../../apps/api/test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../apps/api/test/helpers/platform-app.ts";
import { orgPermissions, presetPermissions } from "../../../apps/api/src/lib/permissions.ts";
import { mintMcpLoopbackToken } from "../src/loopback-auth.ts";
import { platformMcpUrl } from "../src/platform-mcp.ts";
import { turnPermissions } from "../src/turn-permissions.ts";

const app = getTestApp();
await registerTestPlatformApp();

const ORIGIN = "http://localhost";

let owner: TestContext;
let caller: TestContext;
let gestion: { id: string };
let lecture: { id: string };
let ceiling: string[];

/** The turn's ceiling: the union over the caller's three roles, less what the turn narrows. */
const unionOf = (...presets: Array<"operator" | "admin" | "viewer">) => [
  ...new Set([
    ...orgPermissions("member"),
    ...presets.flatMap((preset) => [...presetPermissions(preset)]),
  ]),
];

function bearer(user: TestContext, permissions: readonly string[]): Record<string, string> {
  return {
    Authorization: `Bearer ${mintMcpLoopbackToken({
      userId: user.user.id,
      email: user.user.email,
      name: user.user.name,
      orgId: owner.orgId,
      orgRole: "member",
      permissions,
    })}`,
    "X-Org-Id": owner.orgId,
  };
}

let nextId = 1;
async function rpc(
  headers: Record<string, string>,
  method: string,
  params: Record<string, unknown>,
): Promise<JsonRpcEnvelope> {
  const url = new URL(platformMcpUrl(ORIGIN, owner.orgId, null));
  const res = await app.request(`${url.pathname}${url.search}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = await res.text();
  return body ? (JSON.parse(body) as JsonRpcEnvelope) : {};
}

async function invoke(
  headers: Record<string, string>,
  spaceId: string,
  operationId: string,
  body?: unknown,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const envelope = await rpc(headers, "tools/call", {
    name: "invoke_operation",
    arguments: { operation_id: operationId, space_id: spaceId, ...(body ? { body } : {}) },
  });
  const content = (envelope.result?.content as Array<{ text: string }>) ?? [];
  return {
    isError: Boolean(envelope.result?.isError),
    data: content[0] ? (JSON.parse(content[0].text) as Record<string, unknown>) : {},
  };
}

beforeEach(async () => {
  await truncateAll();
  owner = await createTestContext();
  caller = await memberContext(owner, "member", "operator");
  gestion = await seedSpace({ orgId: owner.orgId, name: "Gestion", visibility: "closed" });
  lecture = await seedSpace({ orgId: owner.orgId, name: "Lecture", visibility: "closed" });
  await seedSpaceMember({ spaceId: gestion.id, userId: caller.user.id, presetRole: "admin" });
  await seedSpaceMember({ spaceId: lecture.id, userId: caller.user.id, presetRole: "viewer" });
  ceiling = turnPermissions(unionOf("operator", "admin", "viewer"), {
    authoring: true,
    skillMode: "auto",
  });
});

describe("an organization session's loopback bearer on /api/mcp/o/:org", () => {
  it("carries a permission only one space grants, without lending it to another", async () => {
    // The ceiling holds `agents:write` (Gestion's admin) though the default space's operator lacks it.
    expect(presetPermissions("operator")).not.toContain("agents:write");
    expect(ceiling).toContain("agents:write");
    const headers = bearer(caller, ceiling);

    // Named in Gestion, the write is decided there, by the admin role: the guard passes
    // (the empty body is the route's own 400, after the permission).
    const inGestion = await invoke(headers, gestion.id, "createAgent", {});
    expect(inGestion.data.status).not.toBe(403);
    expect(inGestion.data.code).not.toBe("not_granted");
    expect((inGestion.data.space as { id: string }).id).toBe(gestion.id);

    // Named in the default space, the same write is refused there: never served by Gestion's grant.
    const inDefault = await invoke(headers, owner.defaultSpaceId, "createAgent", {});
    expect(inDefault.isError).toBe(true);
    expect(inDefault.data.code).toBe("not_granted");
    expect(inDefault.data.status).toBe(403);
    expect(inDefault.data.granted_in).toEqual([gestion.id]);
    expect((inDefault.data.space as { id: string }).id).toBe(owner.defaultSpaceId);
  });

  it("refuses an act in a space whose role lacks it, and a space the caller does not reach", async () => {
    const headers = bearer(caller, ceiling);
    // A viewer cannot invoke at all, however much the ceiling holds.
    const inLecture = await invoke(headers, lecture.id, "listAgents");
    expect(inLecture.isError).toBe(true);
    expect(inLecture.data.granted_in as string[]).not.toContain(lecture.id);
    expect(inLecture.data.granted_in as string[]).toContain(gestion.id);

    const foreign = await seedSpace({ orgId: owner.orgId, name: "Foreign", visibility: "closed" });
    const unknown = await invoke(headers, foreign.id, "listAgents");
    expect(unknown.isError).toBe(true);
    expect(unknown.data.code).toBe("unknown_space");
    expect(unknown.data.accepted as string[]).not.toContain(foreign.id);
  });

  it("is narrowed by the turn: without authoring the write is refused in Gestion too", async () => {
    const narrowed = turnPermissions(unionOf("operator", "admin", "viewer"), {
      authoring: false,
      skillMode: "auto",
    });
    expect(narrowed).not.toContain("agents:write");
    const refused = await invoke(bearer(caller, narrowed), gestion.id, "createAgent", {});
    expect(refused.isError).toBe(true);
    expect(refused.data.code).toBe("not_granted");
  });

  it("lists the caller's own spaces in every tool, so a surface is never another caller's", async () => {
    const listed = async (user: TestContext) => {
      const envelope = await rpc(bearer(user, ceiling), "tools/list", {});
      const tools = envelope.result?.tools as Array<{
        name: string;
        inputSchema: { properties: { space_id: { enum: string[] } } };
      }>;
      return tools.find((tool) => tool.name === "invoke_operation")!.inputSchema.properties.space_id
        .enum;
    };
    // Same bearer permissions, different reach: a cache keyed on the permissions alone would hand
    // one caller the other's spaces.
    const stranger = await memberContext(owner, "member", "operator");
    expect((await listed(caller)).sort()).toEqual(
      [owner.defaultSpaceId, gestion.id, lecture.id].sort(),
    );
    expect(await listed(stranger)).toEqual([owner.defaultSpaceId]);
  });
});
