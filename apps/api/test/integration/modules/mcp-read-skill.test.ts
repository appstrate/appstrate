// SPDX-License-Identifier: Apache-2.0

/**
 * `read_skill` through the real `/api/mcp/o/:org` endpoint, and the rule it
 * reads by (`resolveSkillReadAccess`):
 *
 *  1. a skill the current space ENFORCES, for a caller who chats there: its
 *     latest published version only, whatever the caller's `skills:*`;
 *  2. otherwise `skills:read`: what the REST file explorer serves — the draft
 *     to an author, the latest published version to a reader;
 *  3. otherwise the REST refusal: 403 without `skills:read`, 404 with it.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { packageDistTags } from "@appstrate/db/schema";
import { zipArtifact } from "@appstrate/core/zip";
import { computeIntegrity } from "@appstrate/core/integrity";
import * as storage from "@appstrate/db/storage";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  authHeaders,
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
import { mcpRpc, type JsonRpcEnvelope } from "../../helpers/mcp.ts";
import { registerTestPlatformApp } from "../../helpers/platform-app.ts";
import {
  AGENT_PACKAGES_BUCKET,
  versionZipKey,
} from "../../../src/services/package-storage-keys.ts";
// By path, as `chat-agent-authoring-ceiling.test.ts` does: the minting secret is
// process-local to the module instance whose auth strategy the app registered.
import { mintMcpLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";
import { turnPermissions } from "../../../../../packages/module-chat/src/turn-permissions.ts";

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

/**
 * A member holding exactly `permissions`, through a custom role, in each of
 * `spaceIds`; the headers name the default space.
 */
async function customMember(
  permissions: string[],
  spaceIds = [owner.defaultSpaceId],
): Promise<Record<string, string>> {
  const user = await createTestUser();
  await addOrgMember(owner.orgId, user.id, "guest");
  const role = await seedSpaceRole({ orgId: owner.orgId, permissions });
  for (const spaceId of spaceIds) {
    await seedSpaceMember({ spaceId, userId: user.id, presetRole: null, customRoleId: role.id });
  }
  return authHeaders({ ...owner, cookie: user.cookie });
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
  await seedSpacePackage(owner.defaultSpaceId, TONE, { chatEnforced: true });
  await publish(TONE, "1.0.0");
});

describe("read_skill — a skill the space enforces", () => {
  let chatter: Record<string, string>;
  beforeEach(async () => {
    chatter = await customMember(["mcp:read", "chat:write"]);
  });

  it("is declared to a caller holding no skills:* at all", async () => {
    const { envelope } = await rpc(chatter, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const names = (envelope.result?.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("read_skill");
  });

  it("serves SKILL.md, the files and one file at the published version, never the draft", async () => {
    expect(await readSkill(chatter, { id: TONE })).toEqual({
      isError: false,
      data: {
        id: TONE,
        version: "1.0.0",
        definition: "published",
        content: `published ${TONE} 1.0.0`,
        files: PUBLISHED_FILES,
      },
    });
    expect(await readSkill(chatter, { id: TONE, path: "scripts/run.sh" })).toEqual({
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

  it("follows `latest` to a newer publish", async () => {
    await publish(TONE, "1.1.0");
    const { data } = await readSkill(chatter, { id: TONE, path: "references/guide.md" });
    expect(data).toMatchObject({ version: "1.1.0", content: "guide 1.1.0" });
  });

  it("serves the AUTHOR the published version too — the one their chat turn injects", async () => {
    const { data } = await readSkill(authHeaders(owner), { id: TONE });
    expect(data).toMatchObject({
      version: "1.0.0",
      definition: "published",
      content: `published ${TONE} 1.0.0`,
    });
  });

  it("stops once the skill is switched off in the space", async () => {
    await seedSpacePackage(owner.defaultSpaceId, TONE, { enabled: false });
    expect(await readSkill(chatter, { id: TONE })).toEqual({ isError: true, data: FORBIDDEN });
  });

  it("stops once the enforcement is released", async () => {
    await seedSpacePackage(owner.defaultSpaceId, TONE, { chatEnforced: false });
    expect(await readSkill(chatter, { id: TONE })).toEqual({ isError: true, data: FORBIDDEN });
  });

  it("serves nothing while no version is published", async () => {
    await db.delete(packageDistTags).where(eq(packageDistTags.packageId, TONE));
    expect(await readSkill(chatter, { id: TONE })).toEqual({ isError: true, data: FORBIDDEN });
  });

  it("ignores another space's enforcement", async () => {
    const other = await seedSpace({ orgId: owner.orgId, name: "Other" });
    const elsewhere = "@readskill/elsewhere";
    await seedSkill(elsewhere);
    await publish(elsewhere, "1.0.0");
    await seedSpacePackage(owner.defaultSpaceId, elsewhere);
    await seedPackageShare(other.id, elsewhere);
    await seedSpacePackage(other.id, elsewhere, { chatEnforced: true });

    expect(await readSkill(chatter, { id: elsewhere })).toEqual({ isError: true, data: FORBIDDEN });
  });

  it("ignores another organization's enforcement", async () => {
    const rival = await createTestContext({ orgSlug: "rival" });
    await seedPackage({
      id: "@rival/tone",
      orgId: rival.orgId,
      type: "skill",
      homeSpaceId: rival.defaultSpaceId,
      draftManifest: { name: "@rival/tone", version: "0.0.0", type: "skill" },
    });
    await seedSpacePackage(rival.defaultSpaceId, "@rival/tone", { chatEnforced: true });
    await publish("@rival/tone", "1.0.0");

    expect(await readSkill(chatter, { id: "@rival/tone" })).toEqual({
      isError: true,
      data: FORBIDDEN,
    });
  });

  it("is not opened to a caller who does not chat in the space", async () => {
    const nonChatter = await customMember(["mcp:read"]);
    expect(await readSkill(nonChatter, { id: TONE })).toEqual({ isError: true, data: FORBIDDEN });
  });
});

describe("read_skill — the request's space decides which enforcement applies", () => {
  it("serves a skill enforced in space B only to a request made in B", async () => {
    const teamB = await seedSpace({ orgId: owner.orgId, name: "Team B" });
    const team = "@readskill/team";
    await seedSkill(team, teamB.id);
    await publish(team, "1.0.0");
    await seedSpacePackage(teamB.id, team, { chatEnforced: true });
    // Also active in the default space, but not enforced there.
    await seedPackageShare(owner.defaultSpaceId, team);
    await seedSpacePackage(owner.defaultSpaceId, team);
    const headers = await customMember(
      ["mcp:read", "chat:write"],
      [owner.defaultSpaceId, teamB.id],
    );
    const { "X-Space-Id": _default, ...noSpace } = headers;

    expect(
      (await readSkill({ ...headers, "X-Space-Id": teamB.id }, { id: team })).data,
    ).toMatchObject({ version: "1.0.0", content: `published ${team} 1.0.0` });
    expect(await readSkill(headers, { id: team })).toEqual({ isError: true, data: FORBIDDEN });
    expect(await readSkill(noSpace, { id: team })).toEqual({ isError: true, data: FORBIDDEN });
  });
});

describe("read_skill — a role preview", () => {
  it("answers as the persona: no skills:read and no chat:write means refused", async () => {
    const persona = async (permissions: string[]) => {
      const role = await seedSpaceRole({ orgId: owner.orgId, permissions });
      return {
        ...authHeaders(owner),
        "X-View-As": `org_role=member; space=${owner.defaultSpaceId}; role=custom:${role.id}`,
      };
    };
    expect(await readSkill(await persona(["mcp:read"]), { id: TONE })).toEqual({
      isError: true,
      data: FORBIDDEN,
    });
    // The control: the same preview allowed to chat reads the enforced skill.
    expect(
      (await readSkill(await persona(["mcp:read", "chat:write"]), { id: TONE })).data,
    ).toMatchObject({ version: "1.0.0" });
  });
});

describe("read_skill — a strict-mode chat turn", () => {
  it("reads the enforced skill and nothing else, with every skills:* stripped", async () => {
    const other = "@readskill/chosen";
    await seedSkill(other);
    await seedSpacePackage(owner.defaultSpaceId, other);
    await publish(other, "1.0.0");

    // The owner's resolved set in the space, narrowed as a strict turn narrows it.
    const listed = await app.request("/api/spaces", {
      headers: { Cookie: owner.cookie, "X-Org-Id": owner.orgId },
    });
    const { data: spaces } = (await listed.json()) as {
      data: Array<{ id: string; permissions: string[] }>;
    };
    const resolved = spaces.find((space) => space.id === owner.defaultSpaceId)!.permissions;
    expect(resolved).toContain("skills:read");
    expect(resolved).toContain("chat:write");
    const strict = turnPermissions(resolved, { authoring: false, skillMode: "strict" });
    expect(strict.some((permission) => permission.startsWith("skills:"))).toBe(false);
    const token = mintMcpLoopbackToken({
      userId: owner.user.id,
      email: owner.user.email,
      name: owner.user.name,
      orgId: owner.orgId,
      orgRole: "owner",
      permissions: strict,
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      "X-Org-Id": owner.orgId,
      "X-Space-Id": owner.defaultSpaceId,
    };

    expect((await readSkill(headers, { id: TONE })).data).toMatchObject({
      version: "1.0.0",
      content: `published ${TONE} 1.0.0`,
    });
    expect(await readSkill(headers, { id: other })).toEqual({ isError: true, data: FORBIDDEN });
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
    expect(await readSkill(authHeaders(owner), { id: CHOSEN })).toEqual({
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

  it("serves an author the draft of an enforced skill that has no published version", async () => {
    // Nothing enforced to serve, so the author's own skills:read decides — deliberately.
    await db.delete(packageDistTags).where(eq(packageDistTags.packageId, TONE));
    const { data } = await readSkill(authHeaders(owner), { id: TONE });
    expect(data).toMatchObject({ version: null, definition: "draft", content: `draft ${TONE}` });
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
    const viewer = authHeaders(await memberContext(owner, "member", "viewer"));
    const { data } = await readSkill(viewer, { id: system });
    expect(data).toMatchObject({
      id: system,
      version: null,
      definition: "published",
      content: "system tone",
    });
  });

  it("serves a reader who cannot write it the latest published version", async () => {
    const viewer = authHeaders(await memberContext(owner, "member", "viewer"));
    const { data } = await readSkill(viewer, { id: CHOSEN, path: "scripts/run.sh" });
    expect(data).toMatchObject({
      version: "1.0.0",
      definition: "published",
      content: "echo 1.0.0",
    });
  });

  it("answers 404 for a skill this space cannot reach, and for a package that is no skill", async () => {
    const viewer = authHeaders(await memberContext(owner, "member", "viewer"));
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
    const chatter = await customMember(["mcp:read", "chat:write"]);
    for (const id of [CHOSEN, "@readskill/nothing"]) {
      expect(await readSkill(chatter, { id })).toEqual({ isError: true, data: FORBIDDEN });
    }
  });

  it("answers 404 for a path the version does not hold, traversal included", async () => {
    for (const path of ["missing.md", "../SKILL.md", "./SKILL.md", "/SKILL.md", "__proto__"]) {
      expect(await readSkill(authHeaders(owner), { id: TONE, path })).toEqual({
        isError: true,
        data: refusal(404, "not_found", "Not Found", "File not found"),
      });
    }
  });

  it("refuses an argument it does not declare", async () => {
    const { envelope } = await rpc(authHeaders(owner), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_skill", arguments: { id: TONE, version: "draft" } },
    });
    expect(JSON.stringify(envelope)).toContain("Unknown argument(s): version");
  });
});
