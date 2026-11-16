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

  it("refuses a space outside the chat's acting set (a viewer there) like one the caller does not reach", async () => {
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

  it("lists the skills of the acting set alone", async () => {
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
      skillMode: "auto",
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

  it("lists the acting set in every tool, so a surface is never another caller's", async () => {
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
    // Lecture (viewer: no `chat:write`) is reached but is no place the chat acts.
    expect((await listed(caller)).sort()).toEqual([owner.defaultSpaceId, gestion.id].sort());
    expect(await listed(stranger)).toEqual([owner.defaultSpaceId]);
  });
});
