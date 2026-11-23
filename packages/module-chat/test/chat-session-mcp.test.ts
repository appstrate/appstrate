// SPDX-License-Identifier: Apache-2.0

/**
 * A chat turn's loopback bearer against the REAL organization MCP endpoint (`/api/mcp/o/:org`).
 *
 * The bearer is a CEILING, not a grant: its permission list is the union of the
 * caller's effective sets over the turn's spaces, and each space entry
 * recomputes `(org ∪ role in that space) ∩ ceiling`. So a permission held in one
 * space is in the list and still cannot act in another where the caller's role
 * lacks it. It also carries the turn's spaces as a credential allowlist: it reaches
 * those alone, and each request acts in one of them. The caller
 * here is `operator` in the default space, `admin` in "Gestion" and `viewer` in
 * "Lecture"; the turn's spaces are the first two (a viewer holds no `chat:write`).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { packageDistTags } from "@appstrate/db/schema";
import { zipArtifact } from "@appstrate/core/zip";
import { computeIntegrity } from "@appstrate/core/integrity";
import * as storage from "@appstrate/db/storage";
import {
  AGENT_PACKAGES_BUCKET,
  versionZipKey,
} from "../../../apps/api/src/services/package-storage-keys.ts";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { db, truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  memberContext,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import {
  seedPackage,
  seedPackageVersion,
  seedRun,
  seedSpace,
  seedSpaceMember,
  seedSpacePackage,
} from "../../../apps/api/test/helpers/seed.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../../apps/api/test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../apps/api/test/helpers/platform-app.ts";
import { orgPermissions, presetPermissions } from "../../../apps/api/src/lib/permissions.ts";
import { mintMcpLoopbackToken } from "../src/loopback-auth.ts";
import { platformMcpUrl } from "../src/platform-mcp.ts";
import { limitedConversationPermissions, turnPermissions } from "../src/turn-permissions.ts";

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

/** The turn's spaces: where the caller can act (Lecture's viewer holds no `chat:write`). */
const turnSpaces = () => [owner.defaultSpaceId, gestion.id];

function bearer(
  user: TestContext,
  permissions: readonly string[],
  spaceIds: readonly string[] = turnSpaces(),
): Record<string, string> {
  return {
    Authorization: `Bearer ${mintMcpLoopbackToken({
      userId: user.user.id,
      email: user.user.email,
      name: user.user.name,
      orgId: owner.orgId,
      orgRole: "member",
      permissions,
      spaceIds,
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
  const { envelope } = await post(headers, method, params);
  return envelope;
}

async function post(
  headers: Record<string, string>,
  method: string,
  params: Record<string, unknown>,
): Promise<{ status: number; envelope: JsonRpcEnvelope }> {
  const url = new URL(platformMcpUrl(ORIGIN, owner.orgId));
  const res = await app.request(`${url.pathname}${url.search}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = await res.text();
  return { status: res.status, envelope: body ? (JSON.parse(body) as JsonRpcEnvelope) : {} };
}

async function invoke(
  headers: Record<string, string>,
  spaceId: string,
  operationId: string,
  body?: unknown,
  pathParams?: Record<string, string>,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const envelope = await rpc(headers, "tools/call", {
    name: "invoke_operation",
    arguments: {
      operation_id: operationId,
      space_id: spaceId,
      ...(body ? { body } : {}),
      ...(pathParams ? { path_params: pathParams } : {}),
    },
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
    skillDiscovery: true,
  });
});

describe("a chat turn's loopback bearer on the MCP endpoints", () => {
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

  it("refuses a space outside the bearer's allowlist (a viewer there) like one the caller does not reach", async () => {
    const headers = bearer(caller, ceiling);
    // The caller reaches Lecture as a viewer, who holds no `chat:write`: the chat acts nowhere there.
    expect(presetPermissions("viewer")).not.toContain("chat:write");
    const inLecture = await invoke(headers, lecture.id, "listAgents");
    expect(inLecture.isError).toBe(true);
    expect(inLecture.data.code).toBe("unknown_space");
    expect(inLecture.data.accepted as string[]).not.toContain(lecture.id);
    expect(inLecture.data.accepted as string[]).toContain(gestion.id);

    const foreign = await seedSpace({ orgId: owner.orgId, name: "Foreign", visibility: "closed" });
    const unknown = await invoke(headers, foreign.id, "listAgents");
    expect(unknown.isError).toBe(true);
    expect(unknown.data.code).toBe("unknown_space");
    expect(unknown.data.accepted as string[]).not.toContain(foreign.id);
  });

  it("enters no space outside its allowlist, though the caller reaches it", async () => {
    // The caller is an admin in Gestion; the bearer allowlists the default space alone.
    const headers = bearer(caller, ceiling, [owner.defaultSpaceId]);
    const named = await invoke(headers, gestion.id, "listAgents");
    expect(named.isError).toBe(true);
    expect(named.data.code).toBe("unknown_space");
    expect(named.data.accepted as string[]).toEqual([owner.defaultSpaceId]);
  });

  it("refuses an empty allowlist without claiming the caller holds no role", async () => {
    const { status, envelope } = await post(bearer(caller, ceiling, []), "tools/list", {});
    expect(status).toBe(403);
    expect(JSON.stringify(envelope)).toContain("this credential reaches");
  });

  it("serves an external org-wide client every space it reaches, the viewer one included", async () => {
    const envelope = await rpc(
      { Cookie: caller.cookie, "X-Org-Id": owner.orgId },
      "tools/list",
      {},
    );
    const tools = envelope.result?.tools as Array<{
      name: string;
      inputSchema: { properties: { space_id: { enum: string[] } } };
    }>;
    const listed = tools.find((tool) => tool.name === "invoke_operation")!.inputSchema.properties
      .space_id.enum;
    expect(listed).toContain(lecture.id);
  });

  it("lists the skills of the bearer's spaces alone", async () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const seedSkill = async (id: string, name: string, spaceId: string) => {
      await seedPackage({
        id,
        orgId: owner.orgId,
        type: "skill",
        homeSpaceId: spaceId,
        draftManifest: { name: id, version: "0.0.0", type: "skill" },
        draftContent: `---\nname: ${name}\ndescription: ${name}.\n---\nBody\n`,
      });
      await seedSpacePackage(spaceId, id);
      const manifest = { name: id, version: "1.0.0", type: "skill" };
      const zip = zipArtifact({
        "manifest.json": encode(JSON.stringify(manifest)),
        "SKILL.md": encode(`---\nname: ${name}\ndescription: ${name}.\n---\nBody\n`),
      });
      await storage.uploadFile(AGENT_PACKAGES_BUCKET, versionZipKey(id, "1.0.0"), zip);
      const row = await seedPackageVersion({
        packageId: id,
        version: "1.0.0",
        manifest,
        integrity: computeIntegrity(zip),
        artifactSize: zip.byteLength,
      });
      await db.insert(packageDistTags).values({ packageId: id, tag: "latest", versionId: row.id });
    };
    await seedSkill("@chatorg/in-gestion", "in-gestion", gestion.id);
    await seedSkill("@chatorg/in-lecture", "in-lecture", lecture.id);

    const listUris = async (headers: Record<string, string>) => {
      const envelope = await rpc(headers, "skills/list", {});
      return (envelope.result?.skills as Array<{ uri: string }>).map((entry) => entry.uri);
    };
    const chat = await listUris(bearer(caller, ceiling));
    expect(chat.some((uri) => uri.startsWith(`skill://${gestion.id}/`))).toBe(true);
    expect(chat.some((uri) => uri.startsWith(`skill://${lecture.id}/`))).toBe(false);
    // An external client reads every space it reaches.
    const external = await listUris({ Cookie: caller.cookie, "X-Org-Id": owner.orgId });
    expect(external.some((uri) => uri.startsWith(`skill://${lecture.id}/`))).toBe(true);
  });

  it("is narrowed by the turn: without authoring the write is refused in Gestion too", async () => {
    const narrowed = turnPermissions(unionOf("operator", "admin", "viewer"), {
      authoring: false,
      skillDiscovery: true,
    });
    expect(narrowed).not.toContain("agents:write");
    const refused = await invoke(bearer(caller, narrowed), gestion.id, "createAgent", {});
    expect(refused.isError).toBe(true);
    expect(refused.data.code).toBe("not_granted");
  });

  it("reads the space an org-wide list names, never the spaces it does not (the chat records the named one only)", async () => {
    // One run of the caller's in the default space and one in Gestion: both readable by the caller.
    const runIn = async (spaceId: string) => {
      const pkg = await seedPackage({
        id: `@chatorg/agent-${crypto.randomUUID().slice(0, 8)}`,
        orgId: owner.orgId,
        homeSpaceId: spaceId,
        createdBy: owner.user.id,
      });
      await seedSpacePackage(spaceId, pkg.id);
      return seedRun({
        packageId: pkg.id,
        orgId: owner.orgId,
        spaceId,
        userId: caller.user.id,
        status: "success",
        startedAt: new Date(),
      });
    };
    const inDefault = await runIn(owner.defaultSpaceId);
    const inGestion = await runIn(gestion.id);

    const listed = await invoke(
      bearer(caller, ceiling),
      owner.defaultSpaceId,
      "listOrgRuns",
      undefined,
      {
        orgId: owner.orgId,
      },
    );
    expect(listed.data.status).toBe(200);
    const ids = (listed.data.body as { data: Array<{ id: string }> }).data.map((row) => row.id);
    expect(ids).toContain(inDefault.id);
    expect(ids).not.toContain(inGestion.id);
  });

  it("keeps a limited conversation of an org owner off every org-level write, not off its origin space", async () => {
    const union = [...orgPermissions("owner"), ...presetPermissions("admin"), "mcp:read"];
    // What `handleChatStream` mints for each case over the same reach.
    const limited = limitedConversationPermissions(union, orgPermissions("owner"));
    const bearerWith = (permissions: readonly string[]) => ({
      Authorization: `Bearer ${mintMcpLoopbackToken({
        userId: owner.user.id,
        email: owner.user.email,
        name: owner.user.name,
        orgId: owner.orgId,
        orgRole: "owner",
        permissions,
        spaceIds: [owner.defaultSpaceId],
      })}`,
      "X-Org-Id": owner.orgId,
    });
    const proxy = { label: "Egress", url: "http://proxy.example.com:8080" };
    const statusOf = async (
      permissions: readonly string[],
      operationId: string,
      body: unknown,
      pathParams?: Record<string, string>,
    ) =>
      (await invoke(bearerWith(permissions), owner.defaultSpaceId, operationId, body, pathParams))
        .data.status;

    // Limited: an org-level write is refused, whatever the org role; a space write in the origin
    // is not, and the reads the turn needs stay.
    expect(await statusOf(limited, "createProxy", proxy)).toBe(403);
    expect(
      await statusOf(
        limited,
        "inviteMember",
        { email: "new@example.com", role: "member" },
        { orgId: owner.orgId },
      ),
    ).toBe(403);
    expect(await statusOf(limited, "createEndUser", { name: "Alice" })).toBe(201);
    expect(await statusOf(limited, "listSpaces", undefined)).toBe(200);
    // Unlimited (same allowlist kind, the caller's org grants kept): the same write goes through.
    expect(await statusOf(union, "createProxy", proxy)).toBe(201);
    expect(
      await statusOf(
        union,
        "inviteMember",
        { email: "new@example.com", role: "member" },
        { orgId: owner.orgId },
      ),
    ).toBe(201);
  });

  it("offers the chat get_me, which names the bearer's spaces alone", async () => {
    const headers = bearer(caller, ceiling);
    const tools = (await rpc(headers, "tools/list", {})).result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toContain("get_me");

    const envelope = await rpc(headers, "tools/call", {
      name: "get_me",
      arguments: { space_id: gestion.id },
    });
    expect(envelope.result?.isError).toBeFalsy();
    const content = envelope.result?.content as Array<{ text: string }>;
    const me = JSON.parse(content[0]!.text) as {
      spaces: Array<{ id: string }>;
      body: { space: { id: string } };
    };
    expect(me.spaces.map((space) => space.id).sort()).toEqual(turnSpaces().sort());
    expect(me.body.space.id).toBe(gestion.id);
    // Outside the allowlist, though the caller reaches it as a viewer: refused.
    const outside = await rpc(headers, "tools/call", {
      name: "get_me",
      arguments: { space_id: lecture.id },
    });
    expect(outside.result?.isError).toBe(true);
  });

  it("lists the bearer's spaces in every tool, so a surface is never another caller's", async () => {
    const listed = async (user: TestContext, spaceIds: readonly string[]) => {
      const envelope = await rpc(bearer(user, ceiling, spaceIds), "tools/list", {});
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
    // Lecture (viewer: no `chat:write`) is reached but is no place the chat acts.
    expect((await listed(caller, turnSpaces())).sort()).toEqual(
      [owner.defaultSpaceId, gestion.id].sort(),
    );
    expect(await listed(stranger, turnSpaces())).toEqual([owner.defaultSpaceId]);
  });
});
