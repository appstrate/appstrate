// SPDX-License-Identifier: Apache-2.0

/**
 * `read_skill` through the real `/api/mcp/o/:org` endpoint, and the rule it
 * reads by (`resolveSkillReadAccess`):
 *
 *  1. a skill the chat turn injected (the chat bearer's signed claim, in the
 *     turn's space, while the caller may chat there): the version injected, or
 *     the draft while unchanged — whatever the turn's `skills:*`;
 *  2. otherwise `skills:read`: what the REST file explorer serves — the draft
 *     to an author, the latest published version to a reader;
 *  3. otherwise the REST refusal: 403 without `skills:read`, 404 with it.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { packageDistTags, packages, spaceRoles } from "@appstrate/db/schema";
import { zipArtifact } from "@appstrate/core/zip";
import { computeIntegrity } from "@appstrate/core/integrity";
import * as storage from "@appstrate/db/storage";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedPackage,
  seedPackageShare,
  seedPackageVersion,
  seedSpace,
  seedSpaceMember,
  seedSpacePackage,
  seedSpaceRole,
} from "../../helpers/seed.ts";
import { mcpRpc, type JsonRpcEnvelope, inSpace, mcpAuthHeaders } from "../../helpers/mcp.ts";
import { registerTestPlatformApp } from "../../helpers/platform-app.ts";
import {
  AGENT_PACKAGES_BUCKET,
  versionZipKey,
} from "../../../src/services/package-storage-keys.ts";
// By path, as `chat-agent-authoring-ceiling.test.ts` does: the minting secret is
// process-local to the module instance whose auth strategy the app registered.
import { mintMcpLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";
import { turnPermissions } from "../../../../../packages/module-chat/src/turn-permissions.ts";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import {
  CHAT_LOOPBACK_AUTH_METHOD,
  INJECTED_SKILLS_AUTH_EXTRA,
  type InjectedSkill,
  type InjectedSkills,
} from "@appstrate/core/chat-contract";
import { readSkillSnapshot } from "../../../src/services/skill-read.ts";
import { withPackageDraftLock } from "../../../src/services/package-locks.ts";
import type { AppEnv } from "../../../src/types/index.ts";

const app = getTestApp();
await registerTestPlatformApp();
const rpc = mcpRpc(app);

const TONE = "@readskill/tone";
const encode = (text: string) => new TextEncoder().encode(text);

let owner: TestContext;

/** A skill homed in `spaceId`, whose DRAFT differs from every published version. */
async function seedSkill(id: string, spaceId = owner.defaultSpaceId): Promise<void> {
  await seedPackage({
    id,
    orgId: owner.orgId,
    type: "skill",
    homeSpaceId: spaceId,
    draftManifest: { name: id, version: "0.0.0", type: "skill" },
    draftContent: `draft ${id}`,
  });
}

/** Publish `version` with SKILL.md and two companion files, and move `latest` onto it. */
async function publish(id: string, version: string): Promise<void> {
  const zip = zipArtifact({
    "manifest.json": encode(JSON.stringify({ name: id, version, type: "skill" })),
    "SKILL.md": encode(`published ${id} ${version}`),
    "scripts/run.sh": encode(`echo ${version}`),
    "references/guide.md": encode(`guide ${version}`),
  });
  await storage.uploadFile(AGENT_PACKAGES_BUCKET, versionZipKey(id, version), zip);
  const row = await seedPackageVersion({
    packageId: id,
    version,
    manifest: { name: id, version, type: "skill" },
    integrity: computeIntegrity(zip),
    artifactSize: zip.byteLength,
  });
  await db
    .insert(packageDistTags)
    .values({ packageId: id, tag: "latest", versionId: row.id })
    .onConflictDoUpdate({
      target: [packageDistTags.packageId, packageDistTags.tag],
      set: { versionId: row.id },
    });
}

/** A guest member holding exactly `permissions` in the default space, through a custom role. */
async function customMember(permissions: string[]) {
  const user = await createTestUser();
  await addOrgMember(owner.orgId, user.id, "guest");
  const role = await seedSpaceRole({ orgId: owner.orgId, permissions });
  await seedSpaceMember({
    spaceId: owner.defaultSpaceId,
    userId: user.id,
    presetRole: null,
    customRoleId: role.id,
  });
  return { user, roleId: role.id, headers: mcpAuthHeaders({ ...owner, cookie: user.cookie }) };
}

async function readSkill(
  headers: Record<string, string>,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const { envelope } = await rpc(headers, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_skill", arguments: args },
  });
  return toolData(envelope);
}

function toolData(envelope: JsonRpcEnvelope): { isError: boolean; data: Record<string, unknown> } {
  const content = (envelope.result?.content as Array<{ type: string; text: string }>) ?? [];
  if (!content[0]) throw new Error(`no tool result: ${JSON.stringify(envelope)}`);
  return { isError: Boolean(envelope.result?.isError), data: JSON.parse(content[0].text) };
}

const PUBLISHED_FILES = [
  { path: "SKILL.md", size: encode(`published ${TONE} 1.0.0`).byteLength },
  { path: "manifest.json", size: expect.any(Number) },
  { path: "references/guide.md", size: 11 },
  { path: "scripts/run.sh", size: 10 },
];

/** The problem body the REST error handler sends, as the tool carries it. */
function refusal(status: number, code: string, title: string, detail: string) {
  return {
    status,
    body: {
      type: `https://docs.appstrate.dev/errors/${code.replace(/_/g, "-")}`,
      title,
      status,
      detail,
      instance: expect.stringMatching(/^urn:appstrate:request:/),
      code,
      request_id: expect.any(String),
    },
  };
}

const FORBIDDEN = refusal(
  403,
  "forbidden",
  "Forbidden",
  "Insufficient permissions: skills:read required",
);

beforeEach(async () => {
  await truncateAll();
  owner = await createTestContext({ orgSlug: "readskill" });
  await seedSkill(TONE);
  await seedSpacePackage(owner.defaultSpaceId, TONE);
  await publish(TONE, "1.0.0");
});

/** The owner's permissions in the default space, as a strict turn narrows them. */
async function strictTurnPermissions(): Promise<string[]> {
  const listed = await app.request("/api/spaces", {
    headers: { Cookie: owner.cookie, "X-Org-Id": owner.orgId },
  });
  const { data } = (await listed.json()) as { data: Array<{ id: string; permissions: string[] }> };
  const resolved = data.find((space) => space.id === owner.defaultSpaceId)!.permissions;
  expect(resolved).toContain("skills:read");
  return turnPermissions(resolved, { authoring: false, skillMode: "strict" });
}

/** The chat turn's MCP bearer, minted by the real loopback strategy. */
function turnHeaders(
  skills: InjectedSkills["skills"],
  opts: {
    permissions?: string[];
    spaceId?: string;
    claimSpaceId?: string;
    user?: { id: string; email: string; name: string };
    orgRole?: string;
  } = {},
): Record<string, string> {
  const spaceId = opts.spaceId ?? owner.defaultSpaceId;
  const user = opts.user ?? owner.user;
  const token = mintMcpLoopbackToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    orgId: owner.orgId,
    orgRole: opts.orgRole ?? "owner",
    permissions: opts.permissions ?? ["mcp:read", "chat:write"],
    injectedSkills: { spaceId: opts.claimSpaceId ?? spaceId, skills },
  });
  return inSpace({ Authorization: `Bearer ${token}`, "X-Org-Id": owner.orgId }, spaceId);
}

const PUBLISHED_1_0: InjectedSkill = { definition: "published", version: "1.0.0" };

/**
 * `readSkillSnapshot` on a hand-built request context, to reach the service's
 * own parse of `authExtra` — a real chat bearer is re-validated by the strategy
 * before it gets there.
 */
function readThroughService(
  authMethod: string,
  permissions: string[],
  injected: unknown,
  packageId = TONE,
) {
  const values = new Map<string, unknown>([
    ["authMethod", authMethod],
    ["permissions", new Set(permissions)],
    ["authExtra", { [INJECTED_SKILLS_AUTH_EXTRA]: injected }],
  ]);
  const c = { get: (key: string) => values.get(key) } as unknown as Context<AppEnv>;
  return readSkillSnapshot(c, { orgId: owner.orgId, spaceId: owner.defaultSpaceId }, packageId);
}

describe("read_skill — a skill the chat turn injected", () => {
  it("is declared to a turn holding no skills:* at all", async () => {
    const { envelope } = await rpc(turnHeaders({}), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const names = (envelope.result?.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("read_skill");
  });

  it("serves SKILL.md, the files and one file at the version injected", async () => {
    const headers = turnHeaders({ [TONE]: PUBLISHED_1_0 });
    expect(await readSkill(headers, { id: TONE })).toEqual({
      isError: false,
      data: {
        id: TONE,
        version: "1.0.0",
        definition: "published",
        content: `published ${TONE} 1.0.0`,
        files: PUBLISHED_FILES,
      },
    });
    expect(await readSkill(headers, { id: TONE, path: "scripts/run.sh" })).toEqual({
      isError: false,
      data: {
        id: TONE,
        version: "1.0.0",
        definition: "published",
        path: "scripts/run.sh",
        size: 10,
        media_kind: "text",
        content: "echo 1.0.0",
      },
    });
  });

  it("stays on the pinned version after a newer publish", async () => {
    await publish(TONE, "1.1.0");
    const { data } = await readSkill(turnHeaders({ [TONE]: PUBLISHED_1_0 }), {
      id: TONE,
      path: "references/guide.md",
    });
    expect(data).toMatchObject({ version: "1.0.0", content: "guide 1.0.0" });
  });

  it("serves the injected draft while it is unchanged, and 409 once it was edited", async () => {
    const headers = turnHeaders({ [TONE]: { definition: "draft", lockVersion: 1 } });
    expect((await readSkill(headers, { id: TONE })).data).toMatchObject({
      version: null,
      definition: "draft",
      content: `draft ${TONE}`,
    });

    await db
      .update(packages)
      .set({ draftContent: "edited", lockVersion: 2 })
      .where(eq(packages.id, TONE));
    const { isError, data } = await readSkill(headers, { id: TONE });
    expect(isError).toBe(true);
    expect(data).toMatchObject({ status: 409, body: { code: "injected_draft_changed" } });
  });

  it("reads a draft under the draft lock, so a save in flight cannot slip in", async () => {
    // A save holds the lock across its row write, upload and commit. On
    // PostgreSQL the read waits for it and then sees the moved `lock_version`;
    // without the lock it would pair the old row with the new files. (PGlite
    // serialises every transaction, so tier 0 cannot tell the two apart.)
    const headers = turnHeaders({ [TONE]: { definition: "draft", lockVersion: 1 } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => (locked = resolve));
    const save = withPackageDraftLock(TONE, async (tx) => {
      await tx.update(packages).set({ lockVersion: 2 }).where(eq(packages.id, TONE));
      locked();
      await held;
    });
    await acquired;
    const read = readSkill(headers, { id: TONE });
    await Bun.sleep(50);
    release();
    await save;
    const { isError, data } = await read;
    expect(isError).toBe(true);
    expect(data).toMatchObject({ status: 409, body: { code: "injected_draft_changed" } });
  });

  it("keeps serving the turn after the skill is switched off, and without any skills:*", async () => {
    // Deliberate: its SKILL.md is already in the turn's context; the next turn
    // no longer injects it. Releasing an enforcement is the same case.
    await seedSpacePackage(owner.defaultSpaceId, TONE, { enabled: false });
    const { data } = await readSkill(turnHeaders({ [TONE]: PUBLISHED_1_0 }), { id: TONE });
    expect(data).toMatchObject({ version: "1.0.0" });
  });

  it("reads under a strict turn's own permissions, every skills:* stripped", async () => {
    const other = "@readskill/other";
    await seedSkill(other);
    await seedSpacePackage(owner.defaultSpaceId, other);
    await publish(other, "1.0.0");
    const permissions = await strictTurnPermissions();
    expect(permissions.some((permission) => permission.startsWith("skills:"))).toBe(false);
    const headers = turnHeaders({ [TONE]: PUBLISHED_1_0 }, { permissions });

    expect((await readSkill(headers, { id: TONE })).data).toMatchObject({ version: "1.0.0" });
    // Not injected: the turn's own grants decide, and it holds no skills:read.
    expect(await readSkill(headers, { id: other })).toEqual({ isError: true, data: FORBIDDEN });
  });

  it("lapses with the caller's live chat:write", async () => {
    const { user, roleId } = await customMember(["mcp:read", "chat:write"]);
    const headers = turnHeaders(
      { [TONE]: PUBLISHED_1_0 },
      { user, orgRole: "guest", permissions: ["mcp:read", "chat:write"] },
    );
    expect((await readSkill(headers, { id: TONE })).data).toMatchObject({ version: "1.0.0" });

    // The same bearer, once the role no longer grants chat:write in the space.
    await db
      .update(spaceRoles)
      .set({ permissions: ["mcp:read"] })
      .where(eq(spaceRoles.id, roleId));
    expect(await readSkill(headers, { id: TONE })).toEqual({ isError: true, data: FORBIDDEN });
  });

  it("holds in the turn's space only", async () => {
    const teamB = await seedSpace({ orgId: owner.orgId, name: "Team B" });
    const team = "@readskill/team";
    await seedSkill(team, teamB.id);
    await publish(team, "1.0.0");
    // Readable from BOTH spaces, so only the claim's space can refuse it.
    await seedPackageShare(owner.defaultSpaceId, team);
    await seedSpacePackage(owner.defaultSpaceId, team);
    const skills = { [team]: PUBLISHED_1_0 };
    expect((await readSkill(turnHeaders(skills), { id: team })).data).toMatchObject({
      version: "1.0.0",
    });

    expect(
      (await readSkill(turnHeaders(skills, { spaceId: teamB.id }), { id: team })).data,
    ).toMatchObject({ version: "1.0.0", content: `published ${team} 1.0.0` });
    // A claim minted for another space is ignored, whichever side differs.
    for (const opts of [
      { spaceId: teamB.id, claimSpaceId: owner.defaultSpaceId },
      { spaceId: owner.defaultSpaceId, claimSpaceId: teamB.id },
    ]) {
      expect(await readSkill(turnHeaders(skills, opts), { id: team })).toEqual({
        isError: true,
        data: FORBIDDEN,
      });
    }
  });

  it("answers from the claim or refuses — never from the turn's own skills:read", async () => {
    await seedPackage({ id: "@readskill/agent", orgId: owner.orgId });
    const headers = turnHeaders(
      {
        // A published claim naming no version cannot be served.
        [TONE]: { definition: "published", version: null },
        "@readskill/agent": PUBLISHED_1_0,
      },
      { permissions: ["mcp:read", "chat:write", "skills:read"] },
    );
    for (const id of [TONE, "@readskill/agent"]) {
      expect(await readSkill(headers, { id })).toEqual({
        isError: true,
        data: refusal(404, "not_found", "Not Found", `Skill '${id}' not found`),
      });
    }
  });

  it("refuses another organization's skill named in the claim", async () => {
    const rival = await createTestContext({ orgSlug: "rival" });
    await seedPackage({
      id: "@rival/tone",
      orgId: rival.orgId,
      type: "skill",
      homeSpaceId: rival.defaultSpaceId,
      draftManifest: { name: "@rival/tone", version: "0.0.0", type: "skill" },
    });
    await seedSpacePackage(rival.defaultSpaceId, "@rival/tone");
    await publish("@rival/tone", "1.0.0");
    const headers = turnHeaders({ "@rival/tone": PUBLISHED_1_0 });
    expect(await readSkill(headers, { id: "@rival/tone" })).toEqual({
      isError: true,
      data: FORBIDDEN,
    });
  });

  it("maps a system skill's published definition to the tree the platform ships", async () => {
    const system = "@appstrate/system-tone";
    await seedPackage({
      id: system,
      orgId: null,
      source: "system",
      type: "skill",
      draftManifest: { name: system, version: "1.0.0", type: "skill" },
      draftContent: "system tone",
    });
    const headers = turnHeaders({ [system]: { definition: "published", version: null } });
    expect((await readSkill(headers, { id: system })).data).toMatchObject({
      version: null,
      definition: "published",
      content: "system tone",
    });
  });
});

describe("read_skill — a chat turn under a role preview", () => {
  it("honours the claim only if the persona may chat in the space", async () => {
    await publish(TONE, "1.1.0");
    const headers = (preset: string) => {
      const token = mintMcpLoopbackToken({
        userId: owner.user.id,
        email: owner.user.email,
        name: owner.user.name,
        orgId: owner.orgId,
        orgRole: "owner",
        permissions: ["mcp:read", "chat:write", "skills:read"],
        viewAs: {
          orgId: owner.orgId,
          orgRole: "member",
          space: { spaceId: owner.defaultSpaceId, role: { kind: "preset", preset } },
        },
        injectedSkills: { spaceId: owner.defaultSpaceId, skills: { [TONE]: PUBLISHED_1_0 } },
      });
      return inSpace(
        { Authorization: `Bearer ${token}`, "X-Org-Id": owner.orgId },
        owner.defaultSpaceId,
      );
    };
    // A builder chats: the pinned version. A viewer does not: the claim is
    // ignored and its own skills:read serves the latest.
    expect((await readSkill(headers("builder"), { id: TONE })).data).toMatchObject({
      version: "1.0.0",
    });
    expect((await readSkill(headers("viewer"), { id: TONE })).data).toMatchObject({
      version: "1.1.0",
    });
  });
});

describe("readSkillSnapshot — the service's own reading of the claim", () => {
  const claim = () => ({ spaceId: owner.defaultSpaceId, skills: { [TONE]: PUBLISHED_1_0 } });

  it("trusts the claim from the chat loopback strategy only", async () => {
    expect(
      await readThroughService(CHAT_LOOPBACK_AUTH_METHOD, ["chat:write"], claim()),
    ).toMatchObject({ version: "1.0.0" });
    // Any other credential carrying the same extra is ignored.
    expect(await readThroughService("api_key", ["chat:write"], claim())).toBeNull();
  });

  it("ignores a malformed claim", async () => {
    for (const malformed of [
      { skills: { [TONE]: PUBLISHED_1_0 } },
      { spaceId: owner.defaultSpaceId, skills: { [TONE]: { definition: "latest" } } },
      { ...claim(), extra: true },
      "not a claim",
    ]) {
      expect(
        await readThroughService(CHAT_LOOPBACK_AUTH_METHOD, ["chat:write"], malformed),
      ).toBeNull();
    }
  });
});

describe("read_skill — a role preview", () => {
  it("answers as the persona, not as the previewing owner", async () => {
    const persona = async (permissions: string[]) => {
      const role = await seedSpaceRole({ orgId: owner.orgId, permissions });
      return {
        ...mcpAuthHeaders(owner),
        "X-View-As": `org_role=member; space=${owner.defaultSpaceId}; role=custom:${role.id}`,
      };
    };
    expect(await readSkill(await persona(["mcp:read"]), { id: TONE })).toEqual({
      isError: true,
      data: FORBIDDEN,
    });
    // The control: the same preview granted skills:read reads it.
    expect(
      (await readSkill(await persona(["mcp:read", "skills:read"]), { id: TONE })).data,
    ).toMatchObject({ version: "1.0.0" });
  });
});

describe("read_skill — a skill read with the caller's own skills:read", () => {
  const CHOSEN = "@readskill/chosen";
  beforeEach(async () => {
    await seedSkill(CHOSEN);
    await seedSpacePackage(owner.defaultSpaceId, CHOSEN);
    await publish(CHOSEN, "1.0.0");
  });

  it("serves an author the draft, as the REST file explorer does", async () => {
    expect(await readSkill(mcpAuthHeaders(owner), { id: CHOSEN })).toEqual({
      isError: false,
      data: {
        id: CHOSEN,
        version: null,
        definition: "draft",
        content: `draft ${CHOSEN}`,
        files: [
          { path: "SKILL.md", size: expect.any(Number) },
          { path: "manifest.json", size: expect.any(Number) },
        ],
      },
    });
  });

  it("serves a system skill as the platform ships it: published, with no version", async () => {
    const system = "@appstrate/system-tone";
    await seedPackage({
      id: system,
      orgId: null,
      source: "system",
      type: "skill",
      draftManifest: { name: system, version: "1.0.0", type: "skill" },
      draftContent: "system tone",
    });
    const viewer = mcpAuthHeaders(await memberContext(owner, "member", "viewer"));
    const { data } = await readSkill(viewer, { id: system });
    expect(data).toMatchObject({
      id: system,
      version: null,
      definition: "published",
      content: "system tone",
    });
  });

  it("serves a reader who cannot write it the latest published version", async () => {
    const viewer = mcpAuthHeaders(await memberContext(owner, "member", "viewer"));
    const { data } = await readSkill(viewer, { id: CHOSEN, path: "scripts/run.sh" });
    expect(data).toMatchObject({
      version: "1.0.0",
      definition: "published",
      content: "echo 1.0.0",
    });
  });

  it("answers 404 for a skill this space cannot reach, and for a package that is no skill", async () => {
    const viewer = mcpAuthHeaders(await memberContext(owner, "member", "viewer"));
    const other = await seedSpace({ orgId: owner.orgId, name: "Other" });
    const unreachable = "@readskill/unreachable";
    await seedSkill(unreachable, other.id);
    await publish(unreachable, "1.0.0");
    await seedPackage({ id: "@readskill/agent", orgId: owner.orgId });

    for (const id of [unreachable, "@readskill/agent", "@readskill/nothing"]) {
      expect(await readSkill(viewer, { id })).toEqual({
        isError: true,
        data: refusal(404, "not_found", "Not Found", `Skill '${id}' not found`),
      });
    }
  });

  it("answers the REST 403 without skills:read, whether or not the id exists", async () => {
    const { headers: chatter } = await customMember(["mcp:read", "chat:write"]);
    for (const id of [CHOSEN, "@readskill/nothing"]) {
      expect(await readSkill(chatter, { id })).toEqual({ isError: true, data: FORBIDDEN });
    }
  });

  it("answers 404 for a path the version does not hold, traversal included", async () => {
    for (const path of ["missing.md", "../SKILL.md", "./SKILL.md", "/SKILL.md", "__proto__"]) {
      expect(await readSkill(mcpAuthHeaders(owner), { id: TONE, path })).toEqual({
        isError: true,
        data: refusal(404, "not_found", "Not Found", "File not found"),
      });
    }
  });

  it("refuses an argument it does not declare", async () => {
    const { envelope } = await rpc(mcpAuthHeaders(owner), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_skill", arguments: { id: TONE, version: "draft" } },
    });
    expect(envelope.error).toBeUndefined();
    const refused = toolData(envelope);
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ code: "unknown_argument", arguments: ["version"] });
    expect(refused.data.error as string).toContain("Unknown argument(s): version");
  });
});
