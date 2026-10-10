// SPDX-License-Identifier: Apache-2.0

/**
 * A chosen skill injected by a real caller-context build is readable through
 * the real MCP `read_skill` with the bearer minted from that build's claim —
 * no hand-built claim, no fake `ETag`. A strict turn holds no `skills:*`, so
 * only the claim can open the read.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import {
  seedPublishedVersion,
  seedSpaceMember,
  seedSpaceRole,
} from "../../../apps/api/test/helpers/seed.ts";
import { mcpRpc, inSpace } from "../../../apps/api/test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../apps/api/test/helpers/platform-app.ts";
import { buildModuleInitContext } from "../../../apps/api/src/lib/modules/registry.ts";
import { buildChatPlatformDeps } from "../src/platform-services.ts";
import { buildCallerContextBlock } from "../src/prompt.ts";
import { turnCapabilities } from "../src/capabilities.ts";
import { turnPermissions } from "../src/turn-permissions.ts";
import { mintMcpLoopbackToken } from "../src/loopback-auth.ts";

const app = getTestApp();
await registerTestPlatformApp();
const rpc = mcpRpc(app);

const SKILL_ID = "@injectedread/tone";
const skillMd = (body: string) => `---\nname: tone\ndescription: "Tone."\n---\n\n${body}`;

let owner: TestContext;

beforeEach(async () => {
  await truncateAll();
  owner = await createTestContext({ orgSlug: "injectedread" });
  const created = await app.request("/api/packages/skills", {
    method: "POST",
    headers: { ...authHeaders(owner), "Content-Type": "application/json" },
    body: JSON.stringify({
      manifest: { name: SKILL_ID, version: "0.1.0", type: "skill", schema_version: "0.1" },
      content: skillMd("Draft body."),
    }),
  });
  expect(created.status).toBe(201);
});

/** A strict turn by `user` with `headers`: the real block, then its bearer. */
async function strictTurn(
  user: { id: string; email: string; name: string },
  headers: Record<string, string>,
  granted: string[],
) {
  const permissions = turnPermissions(granted, { authoring: true, skillMode: "strict" });
  const block = await buildCallerContextBlock(
    { get: (key: string) => ({ orgRole: "member" })[key as "orgRole"] } as never,
    {
      origin: "http://localhost",
      headers,
      spaceId: owner.defaultSpaceId,
      user,
      deps: buildChatPlatformDeps(buildModuleInitContext()),
      capabilities: turnCapabilities((p) => permissions.includes(p)),
      permissions,
      skills: { skillMode: "strict", pinnedSkills: [SKILL_ID] },
      enforced: Promise.resolve([]),
    },
  );
  const token = mintMcpLoopbackToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    orgId: owner.orgId,
    orgRole: "member",
    permissions,
    injectedSkills: block.injected,
  });
  const bearer = inSpace(
    { Authorization: `Bearer ${token}`, "X-Org-Id": owner.orgId },
    owner.defaultSpaceId,
  );
  // Control: the same turn's bearer without the claim, which the read must refuse.
  const unclaimed = {
    ...bearer,
    Authorization: `Bearer ${mintMcpLoopbackToken({
      userId: user.id,
      email: user.email,
      name: user.name,
      orgId: owner.orgId,
      orgRole: "member",
      permissions,
    })}`,
  };
  return { block, permissions, bearer, unclaimed };
}

async function readSkill(headers: Record<string, string>) {
  const { envelope } = await rpc(headers, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_skill", arguments: { id: SKILL_ID } },
  });
  const content = envelope.result?.content as Array<{ text: string }> | undefined;
  if (!content?.[0]) throw new Error(`no tool result: ${JSON.stringify(envelope)}`);
  return {
    isError: Boolean(envelope.result?.isError),
    data: JSON.parse(content[0].text) as Record<string, unknown>,
  };
}

describe("a chosen skill injected in a strict turn, read back through `read_skill`", () => {
  it("serves the author's injected draft, then 409s once the draft is edited", async () => {
    const { block, permissions, bearer, unclaimed } = await strictTurn(
      owner.user,
      authHeaders(owner),
      ["chat:write", "mcp:read", "mcp:invoke", "skills:read", "skills:write"],
    );
    expect(permissions.some((p) => p.startsWith("skills:"))).toBe(false);
    expect(block.text).toContain(`<skill id="${SKILL_ID}" definition="draft">`);
    const served = block.injected.skills[SKILL_ID];
    expect(block.injected.spaceId).toBe(owner.defaultSpaceId);
    expect(served?.definition).toBe("draft");

    expect((await readSkill(unclaimed)).isError).toBe(true);
    expect(await readSkill(bearer)).toMatchObject({
      isError: false,
      data: { id: SKILL_ID, definition: "draft", content: skillMd("Draft body.") },
    });

    const edited = await app.request(`/api/packages/skills/${SKILL_ID}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(owner),
        "Content-Type": "application/json",
        "If-Match": `"${served?.definition === "draft" ? served.lockVersion : -1}"`,
      },
      body: JSON.stringify({ content: skillMd("Edited body.") }),
    });
    expect(edited.status).toBe(200);
    expect(await readSkill(bearer)).toMatchObject({
      isError: true,
      data: { status: 409, body: { code: "injected_draft_changed" } },
    });
  });

  it("serves a reader the published version injected", async () => {
    await seedPublishedVersion(SKILL_ID, "1.3.0", { content: skillMd("Published body.") });
    // A guest reading skills through a custom role: `getSkill` serves them the published version.
    const granted = ["chat:write", "mcp:read", "mcp:invoke", "skills:read"];
    const user = await createTestUser();
    await addOrgMember(owner.orgId, user.id, "guest");
    const role = await seedSpaceRole({ orgId: owner.orgId, permissions: granted });
    await seedSpaceMember({
      spaceId: owner.defaultSpaceId,
      userId: user.id,
      presetRole: null,
      customRoleId: role.id,
    });
    const reader = { id: user.id, email: user.email, name: user.name };
    const { block, bearer, unclaimed } = await strictTurn(
      reader,
      authHeaders({ ...owner, cookie: user.cookie }),
      granted,
    );
    expect(block.text).toContain(`<skill id="${SKILL_ID}" version="1.3.0">`);
    expect(block.injected.skills[SKILL_ID]).toEqual({ definition: "published", version: "1.3.0" });

    expect((await readSkill(unclaimed)).isError).toBe(true);
    expect(await readSkill(bearer)).toMatchObject({
      isError: false,
      data: {
        id: SKILL_ID,
        version: "1.3.0",
        definition: "published",
        content: skillMd("Published body."),
      },
    });
  });
});
