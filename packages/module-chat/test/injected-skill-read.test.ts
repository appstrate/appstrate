// SPDX-License-Identifier: Apache-2.0

/**
 * A chosen skill injected by a real caller-context build — listed and read
 * over a real MCP connection without claim — is readable through the real
 * `resources/read` with the bearer minted from that build's claim, no
 * hand-built claim. A strict turn holds no `skills:*`, so only the claim can
 * open the read.
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
import { buildPlatformMcpTools, connectPlatformMcp } from "../src/pi-chat/mcp-tools.ts";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import { platformMcpUrl } from "../src/platform-mcp.ts";
import { buildCallerContextBlock } from "../src/prompt.ts";
import { turnCapabilities } from "../src/capabilities.ts";
import { turnPermissions } from "../src/turn-permissions.ts";
import { mintMcpLoopbackToken } from "../src/loopback-auth.ts";
import { createHash } from "node:crypto";
import { unzipArtifact } from "@appstrate/core/zip";

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
  orgRole: "owner" | "guest",
) {
  const permissions = turnPermissions(granted, { authoring: true, skillMode: "strict" });
  const block = await buildCallerContextBlock(
    { get: (key: string) => ({ orgRole })[key as "orgRole"] } as never,
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
      // The caller's own permissions, no claim: what `chat-stream.ts` opens.
      openSkillsClient: () =>
        connectPlatformMcp({
          url: platformMcpUrl("http://localhost", owner.orgId, owner.defaultSpaceId),
          headers: {
            Authorization: `Bearer ${mintMcpLoopbackToken({
              userId: user.id,
              email: user.email,
              name: user.name,
              orgId: owner.orgId,
              orgRole,
              permissions: granted,
            })}`,
            "x-org-id": owner.orgId,
          },
          fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
            app.request(new Request(input, init))) as typeof fetch,
        }),
    },
  );
  const token = mintMcpLoopbackToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    orgId: owner.orgId,
    orgRole,
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
      orgRole,
      permissions,
    })}`,
  };
  return { block, permissions, bearer, unclaimed };
}

/** The `skill://` URI of the injected `SKILL.md`, read off its `<skill>` tag. */
function injectedUri(text: string): string {
  const uri = /<skill id="[^"]+" uri="([^"]+)"/.exec(text)?.[1];
  if (!uri) throw new Error(`no injected skill: ${text}`);
  return uri;
}

async function readResource(headers: Record<string, string>, uri: string) {
  const { envelope } = await rpc(headers, {
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri },
  });
  const contents = envelope.result?.contents as Array<{ text: string }> | undefined;
  return { text: contents?.[0]?.text, error: envelope.error };
}

describe("a chosen skill injected in a strict turn, read back through `resources/read`", () => {
  it("serves the author's injected draft, then 409s once the draft is edited", async () => {
    const { block, permissions, bearer, unclaimed } = await strictTurn(
      owner.user,
      authHeaders(owner),
      ["chat:write", "mcp:read", "mcp:invoke", "skills:read", "skills:write"],
      "owner",
    );
    expect(permissions.some((p) => p.startsWith("skills:"))).toBe(false);
    const uri = `skill://${owner.defaultSpaceId}/injectedread/tone@draft/tone/SKILL.md`;
    expect(injectedUri(block.text)).toBe(uri);
    expect(block.text).toContain(`<skill id="${SKILL_ID}" uri="${uri}" definition="draft">`);
    const served = block.injected.skills[SKILL_ID];
    expect(block.injected.spaceId).toBe(owner.defaultSpaceId);
    expect(served?.definition).toBe("draft");

    expect((await readResource(unclaimed, uri)).error).toBeDefined();
    const read = await readResource(bearer, uri);
    expect(read.error).toBeUndefined();
    // The injected SKILL.md is the very text `resources/read` serves.
    expect(block.text).toContain(`definition="draft">\n${read.text!.trim()}\n</skill>`);

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
    expect((await readResource(bearer, uri)).error).toMatchObject({
      code: -32600,
      data: { code: "injected_draft_changed" },
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
      "guest",
    );
    const uri = `skill://${owner.defaultSpaceId}/injectedread/tone/tone/SKILL.md`;
    expect(block.text).toContain(`<skill id="${SKILL_ID}" uri="${uri}" version="1.3.0">`);
    expect(block.injected.skills[SKILL_ID]).toEqual({ definition: "published", version: "1.3.0" });

    expect((await readResource(unclaimed, uri)).error).toBeDefined();
    const read = await readResource(bearer, uri);
    expect(read.text).toContain("Published body.");
    expect(block.text).toContain(`version="1.3.0">\n${read.text!.trim()}\n</skill>`);
  });
});

describe("one skill, the same bytes for the chat, an MCP client and `code sync`", () => {
  it("injects, serves over `resources/read` and archives for `code sync` identical files", async () => {
    await seedPublishedVersion(SKILL_ID, "1.3.0", { content: skillMd("Published body.") });
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
    const headers = authHeaders({ ...owner, cookie: user.cookie });
    const reader = { id: user.id, email: user.email, name: user.name };
    const { block, bearer } = await strictTurn(reader, headers, granted, "guest");
    const uri = injectedUri(block.text);

    // An MCP client: the entry, then every file it lists.
    const { envelope } = await rpc(bearer, {
      jsonrpc: "2.0",
      id: 1,
      method: "skills/get",
      params: { uri },
    });
    const entry = envelope.result?.skill as {
      resources: Array<{ uri: string; digest: string; size: number }>;
    };
    const base = uri.slice(0, -"SKILL.md".length);
    const served: Record<string, string> = {};
    for (const resource of entry.resources) {
      const read = await readResource(bearer, resource.uri);
      expect(read.error).toBeUndefined();
      served[resource.uri.slice(base.length)] = read.text!;
    }

    // `code sync`: the archive it checks against the entry's digests and writes as is.
    const archive = await app.request(
      `/api/packages/skills/served/archive?uri=${encodeURIComponent(uri)}`,
      {
        headers: { ...headers, "X-Space-Id": owner.defaultSpaceId },
      },
    );
    expect(archive.status).toBe(200);
    const files = unzipArtifact(new Uint8Array(await archive.arrayBuffer()));
    const decoder = new TextDecoder();
    expect(Object.keys(files).sort()).toEqual(Object.keys(served).sort());
    for (const resource of entry.resources) {
      const bytes = files[resource.uri.slice(base.length)]!;
      expect(bytes.byteLength).toBe(resource.size);
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(resource.digest);
      expect(decoder.decode(bytes)).toBe(served[resource.uri.slice(base.length)]!);
    }

    // The chat: the injected SKILL.md is that same text.
    expect(served["SKILL.md"]).toContain("Published body.");
    expect(block.text).toContain(`version="1.3.0">\n${served["SKILL.md"]!.trim()}\n</skill>`);
  });
});

describe("`list_skills` then `read_resource` in a manual turn, over the turn's own bearer", () => {
  type Tool = {
    name: string;
    execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
  };

  /** The Pi tools of a manual turn by the owner, its bearer minted from the turn's set. */
  async function manualTurn(authoring: boolean) {
    const permissions = turnPermissions(
      ["chat:write", "mcp:read", "mcp:invoke", "skills:read", "skills:write"],
      { authoring, skillMode: "manual" },
    );
    const turn = await buildPlatformMcpTools({
      url: platformMcpUrl("http://localhost", owner.orgId, owner.defaultSpaceId),
      headers: {
        Authorization: `Bearer ${mintMcpLoopbackToken({
          userId: owner.user.id,
          email: owner.user.email,
          name: owner.user.name,
          orgId: owner.orgId,
          orgRole: "owner",
          permissions,
        })}`,
        "x-org-id": owner.orgId,
      },
      spaceId: owner.defaultSpaceId,
      writeChunk: () => {},
      signal: new AbortController().signal,
      turnBudget: { deadlineAt: Date.now() + 60_000, stepCount: () => 0 },
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        app.request(new Request(input, init))) as typeof fetch,
      listsSkills: true,
    });
    const tools: Tool[] = [];
    const pi = { registerTool: (tool: Tool) => tools.push(tool) } as unknown as ExtensionAPI;
    for (const factory of turn.extensionFactories) factory(pi);
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    const call = async (name: string, params: unknown) =>
      (await tool(name).execute("call", params)).content[0]!.text;
    return { turn, call };
  }

  it("lists the published skill and reads it at the listed URI", async () => {
    await seedPublishedVersion(SKILL_ID, "1.3.0", { content: skillMd("Published body.") });
    const { turn, call } = await manualTurn(true);
    try {
      const listed = JSON.parse(await call("list_skills", {})) as Array<{
        id: string;
        uri: string;
        version: string | null;
      }>;
      const uri = `skill://${owner.defaultSpaceId}/injectedread/tone/tone/SKILL.md`;
      expect(listed).toEqual([{ id: SKILL_ID, description: "Tone.", version: "1.3.0", uri }]);
      expect(await call("read_resource", { uri })).toContain("Published body.");
    } finally {
      await turn.close();
    }
  });

  it("lists a draft only to a turn that may read it", async () => {
    const draftUri = `skill://${owner.defaultSpaceId}/injectedread/tone@draft/tone/SKILL.md`;
    const authoring = await manualTurn(true);
    try {
      const drafts = JSON.parse(
        await authoring.call("list_skills", { definition: "draft" }),
      ) as Array<{
        uri: string;
      }>;
      expect(drafts.map((d) => d.uri)).toEqual([draftUri]);
      expect(await authoring.call("read_resource", { uri: draftUri })).toContain("Draft body.");
    } finally {
      await authoring.turn.close();
    }
    // Authoring off: the turn holds no package write, so it neither lists nor reads the draft.
    const reading = await manualTurn(false);
    try {
      expect(JSON.parse(await reading.call("list_skills", { definition: "draft" }))).toEqual([]);
      const refused = await reading.call("read_resource", { uri: draftUri }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(refused)).toContain("Resource not found");
    } finally {
      await reading.turn.close();
    }
  });
});
