// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP Skills extension (SEP-2640) through the real `/api/mcp/o/:org`
 * endpoint: `skills/list`, `skills/get` and `resources/read` on `skill://`,
 * read with the caller's permissions in each skill's space, and a skill the
 * chat turn injected read from the turn bearer's claim alone.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { packageDistTags } from "@appstrate/db/schema";
import { unzipArtifact, zipArtifact } from "@appstrate/core/zip";
import { parseSkillUri } from "@appstrate/core/skill-uri";
import { computeIntegrity } from "@appstrate/core/integrity";
import * as storage from "@appstrate/db/storage";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedPackage,
  seedPackageVersion,
  seedSpace,
  seedSpaceMember,
  seedSpacePackage,
  seedSpaceRole,
} from "../../helpers/seed.ts";
import { mcpRpc, type JsonRpcEnvelope, inSpace } from "../../helpers/mcp.ts";
import { registerTestPlatformApp } from "../../helpers/platform-app.ts";
import {
  AGENT_PACKAGES_BUCKET,
  versionZipKey,
} from "../../../src/services/package-storage-keys.ts";
// By path, as `mcp-read-skill.test.ts` does: the minting secret is process-local
// to the module instance whose auth strategy the app registered.
import { mintMcpLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";
import type { InjectedSkills } from "@appstrate/core/chat-contract";

const app = getTestApp();
await registerTestPlatformApp();
const rpc = mcpRpc(app);

const TONE = "@skillsext/tone";
const TEAM = "@skillsext/team";
const encode = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const skillMd = (name: string) => `---\nname: ${name}\ndescription: Sets the ${name}.\n---\nBody\n`;

interface Entry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: Array<{ uri: string; digest: string; size: number }>;
}

let owner: TestContext;
let teamB: { id: string };

/** A skill homed and active in `spaceId`, its draft distinct from its published 1.0.0. */
async function seedPublishedSkill(
  id: string,
  name: string,
  spaceId: string,
  orgId = owner.orgId,
): Promise<void> {
  await seedPackage({
    id,
    orgId,
    type: "skill",
    homeSpaceId: spaceId,
    draftManifest: { name: id, version: "0.0.0", type: "skill" },
    draftContent: skillMd(name).replace("Body", "Draft body"),
  });
  await seedSpacePackage(spaceId, id);
  const manifest = { name: id, version: "1.0.0", type: "skill" };
  const zip = zipArtifact({
    "manifest.json": encode(JSON.stringify(manifest)),
    "SKILL.md": encode(skillMd(name)),
    "references/guide.md": encode("guide"),
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
}

/** A skill homed and active in the owner's default space that has a draft and no published version. */
async function seedUnpublishedSkill(id: string, name: string): Promise<void> {
  await seedPackage({
    id,
    orgId: owner.orgId,
    type: "skill",
    homeSpaceId: owner.defaultSpaceId,
    draftManifest: { name: id, version: "0.0.0", type: "skill" },
    draftContent: skillMd(name),
  });
  await seedSpacePackage(owner.defaultSpaceId, id);
}

/** A guest holding exactly the given permissions in each space named, through custom roles. */
async function guest(rolesBySpace: Record<string, string[]>): Promise<Record<string, string>> {
  const user = await createTestUser();
  await addOrgMember(owner.orgId, user.id, "guest");
  for (const [spaceId, permissions] of Object.entries(rolesBySpace)) {
    const role = await seedSpaceRole({ orgId: owner.orgId, permissions });
    await seedSpaceMember({ spaceId, userId: user.id, presetRole: null, customRoleId: role.id });
  }
  return { Cookie: user.cookie, "X-Org-Id": owner.orgId };
}

async function call(
  headers: Record<string, string>,
  method: string,
  params: Record<string, unknown>,
): Promise<JsonRpcEnvelope> {
  return (await rpc(headers, { jsonrpc: "2.0", id: 1, method, params })).envelope;
}

async function listUris(headers: Record<string, string>): Promise<string[]> {
  const envelope = await call(headers, "skills/list", {});
  return ((envelope.result?.skills as Entry[] | undefined) ?? [])
    .map((entry) => entry.uri)
    .filter((uri) => uri.includes("/skillsext/"));
}

const ownerHeaders = () => ({ Cookie: owner.cookie, "X-Org-Id": owner.orgId });
const toneUri = () => `skill://${owner.defaultSpaceId}/skillsext/tone/tone/SKILL.md`;
const teamUri = () => `skill://${teamB.id}/skillsext/team/team/SKILL.md`;

beforeEach(async () => {
  await truncateAll();
  owner = await createTestContext({ orgSlug: "skillsext" });
  teamB = await seedSpace({ orgId: owner.orgId, name: "Team B" });
  await seedPublishedSkill(TONE, "tone", owner.defaultSpaceId);
  await seedPublishedSkill(TEAM, "team", teamB.id);
});

describe("skills/list and resources/read", () => {
  it("serves every listed file whole, its digest and size verifiable", async () => {
    const envelope = await call(inSpace(ownerHeaders(), owner.defaultSpaceId), "skills/list", {});
    const entry = (envelope.result?.skills as Entry[]).find((e) => e.uri === toneUri());
    expect(entry?.frontmatter).toEqual({
      name: "tone",
      description: "Sets the tone.",
      metadata: { version: "1.0.0" },
    });
    expect(entry?.resources.map((r) => r.uri.split("/tone/tone/")[1]).sort()).toEqual([
      "SKILL.md",
      "references/guide.md",
    ]);
    for (const resource of entry!.resources) {
      const read = await call(inSpace(ownerHeaders(), owner.defaultSpaceId), "resources/read", {
        uri: resource.uri,
      });
      const [content] = read.result?.contents as Array<{ text: string }>;
      expect(sha256(encode(content!.text))).toBe(resource.digest);
      expect(encode(content!.text).byteLength).toBe(resource.size);
    }
  });

  it("covers the space of a space URL only, and every space of an organization URL", async () => {
    expect(await listUris(inSpace(ownerHeaders(), owner.defaultSpaceId))).toEqual([toneUri()]);
    expect((await listUris(ownerHeaders())).sort()).toEqual([toneUri(), teamUri()].sort());
    const read = await call(ownerHeaders(), "resources/read", { uri: teamUri() });
    expect((read.result?.contents as Array<{ text: string }>)[0]!.text).toBe(
      skillMd("team").replace("\n---\nBody", "\nmetadata:\n  version: 1.0.0\n---\nBody"),
    );
    const pinned = await call(inSpace(ownerHeaders(), owner.defaultSpaceId), "resources/read", {
      uri: teamUri(),
    });
    expect(pinned.error?.code).toBe(-32002);
  });

  it("reads each space of an org-wide connection with the permissions held there", async () => {
    const headers = await guest({
      [owner.defaultSpaceId]: ["mcp:read", "skills:read"],
      [teamB.id]: ["mcp:read"],
    });
    expect(await listUris(headers)).toEqual([toneUri()]);
    expect((await call(headers, "resources/read", { uri: teamUri() })).error?.code).toBe(-32002);
    expect((await call(headers, "skills/get", { uri: teamUri() })).error?.code).toBe(-32602);
  });

  it("lists and reads nothing without skills:read", async () => {
    const headers = await guest({ [owner.defaultSpaceId]: ["mcp:read"] });
    expect(await listUris(headers)).toEqual([]);
    expect((await call(headers, "resources/read", { uri: toneUri() })).error?.code).toBe(-32002);
  });
});

describe("skills/get on a draft", () => {
  const draftUri = () => `skill://${owner.defaultSpaceId}/skillsext/tone@draft/tone/SKILL.md`;

  it("serves an author the unlisted draft by its @draft URI", async () => {
    const get = await call(ownerHeaders(), "skills/get", { uri: draftUri() });
    expect((get.result?.skill as Entry).uri).toBe(draftUri());
    const read = await call(ownerHeaders(), "resources/read", { uri: draftUri() });
    expect((read.result?.contents as Array<{ text: string }>)[0]!.text).toContain("Draft body");
    expect(await listUris(ownerHeaders())).not.toContain(draftUri());
  });

  it("refuses the draft to a reader who cannot write the package", async () => {
    const headers = await guest({ [owner.defaultSpaceId]: ["mcp:read", "skills:read"] });
    expect((await call(headers, "skills/get", { uri: draftUri() })).error?.code).toBe(-32602);
    expect((await call(headers, "resources/read", { uri: draftUri() })).error?.code).toBe(-32002);
  });
});

describe("REST reflection (`appstrate code sync`)", () => {
  const rest = (headers: Record<string, string>, path: string) =>
    app.request(path, { headers: { ...headers, "X-Space-Id": owner.defaultSpaceId } });
  const archivePath = (uri: string) => `/api/mcp/skills/archive?uri=${encodeURIComponent(uri)}`;

  it("serves the entries and bytes the MCP endpoint serves to the same caller", async () => {
    const mcp = await call(inSpace(ownerHeaders(), owner.defaultSpaceId), "skills/list", {});
    const listed = await rest(ownerHeaders(), "/api/mcp/skills");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { object: string; data: Entry[] };
    expect(body.object).toBe("list");
    expect(body.data).toEqual(mcp.result?.skills as Entry[]);
    const entry = body.data.find((e) => e.uri === toneUri())!;
    const res = await rest(ownerHeaders(), archivePath(entry.uri));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const files = unzipArtifact(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(
      entry.resources.map((resource) => parseSkillUri(resource.uri)!.path).sort(),
    );
    for (const resource of entry.resources) {
      const bytes = files[parseSkillUri(resource.uri)!.path]!;
      expect(sha256(bytes)).toBe(resource.digest);
      const read = await call(inSpace(ownerHeaders(), owner.defaultSpaceId), "resources/read", {
        uri: resource.uri,
      });
      expect(bytes).toEqual(encode((read.result?.contents as Array<{ text: string }>)[0]!.text));
    }
  });

  it("covers the space X-Space-Id names only", async () => {
    const body = (await (await rest(ownerHeaders(), "/api/mcp/skills")).json()) as {
      data: Entry[];
    };
    expect(body.data.map((e) => e.uri)).toContain(toneUri());
    expect(body.data.map((e) => e.uri)).not.toContain(teamUri());
    expect((await rest(ownerHeaders(), archivePath(teamUri()))).status).toBe(404);
  });

  it("serves an archive only for the canonical SKILL.md URI of a skill in the space", async () => {
    const dir = `skill://${owner.defaultSpaceId}/skillsext/tone/tone`;
    for (const uri of [
      `${dir}/../tone/SKILL.md`,
      `${dir}/%2E%2E/tone/SKILL.md`,
      `skill://${owner.defaultSpaceId}/skillsext/tone/tone%2FSKILL.md`,
      `${dir}/refs%2FSKILL.md`,
      toneUri().replace(owner.defaultSpaceId, "spc_other"),
    ]) {
      expect((await rest(ownerHeaders(), archivePath(uri))).status).toBe(404);
    }
    expect((await rest(ownerHeaders(), archivePath(toneUri()))).status).toBe(200);
  });

  it("lists the drafts an author may read with definition=draft, and none to a reader", async () => {
    const draftUri = `skill://${owner.defaultSpaceId}/skillsext/tone@draft/tone/SKILL.md`;
    const mcp = await call(ownerHeaders(), "skills/get", { uri: draftUri });
    const res = await rest(ownerHeaders(), "/api/mcp/skills?definition=draft");
    expect(res.status).toBe(200);
    const drafts = ((await res.json()) as { data: Entry[] }).data;
    const draft = drafts.find((e) => e.uri === draftUri)!;
    expect(draft).toEqual(mcp.result?.skill as Entry);
    expect(draft.frontmatter.metadata).toBeUndefined();
    const reader = await guest({ [owner.defaultSpaceId]: ["skills:read"] });
    const readerDrafts = await rest(reader, "/api/mcp/skills?definition=draft");
    expect(((await readerDrafts.json()) as { data: Entry[] }).data).toEqual([]);
    expect((await rest(reader, archivePath(draftUri))).status).toBe(404);
  });

  it("lists the draft of a skill never published with definition=draft, and serves it", async () => {
    await seedUnpublishedSkill("@skillsext/fresh", "fresh");
    const draftUri = `skill://${owner.defaultSpaceId}/skillsext/fresh@draft/fresh/SKILL.md`;
    const drafts = (await (
      await rest(ownerHeaders(), "/api/mcp/skills?definition=draft")
    ).json()) as {
      data: Entry[];
    };
    expect(drafts.data.map((e) => e.uri)).toContain(draftUri);
    const published = (await (await rest(ownerHeaders(), "/api/mcp/skills")).json()) as {
      data: Entry[];
    };
    expect(published.data.map((e) => e.uri).some((uri) => uri.includes("/fresh"))).toBe(false);
    expect((await rest(ownerHeaders(), archivePath(draftUri))).status).toBe(200);
  });

  it("reads nothing in a space of another organization", async () => {
    const other = await createTestContext({ orgSlug: "skillsother" });
    await seedPublishedSkill("@skillsother/secret", "secret", other.defaultSpaceId, other.orgId);
    const secretUri = `skill://${other.defaultSpaceId}/skillsother/secret/secret/SKILL.md`;
    expect((await call(ownerHeaders(), "skills/get", { uri: secretUri })).error?.code).toBe(-32602);
    expect((await call(ownerHeaders(), "resources/read", { uri: secretUri })).error?.code).toBe(
      -32002,
    );
    const listed = (await call(ownerHeaders(), "skills/list", {})).result?.skills as Entry[];
    expect(listed.map((e) => e.uri)).not.toContain(secretUri);
    const res = await app.request(archivePath(secretUri), {
      headers: { ...ownerHeaders(), "X-Space-Id": other.defaultSpaceId },
    });
    expect([403, 404]).toContain(res.status);
    expect((await rest(ownerHeaders(), archivePath(secretUri))).status).toBe(404);
  });

  it("serves the published version in metadata.version", async () => {
    const body = (await (await rest(ownerHeaders(), "/api/mcp/skills")).json()) as {
      data: Entry[];
    };
    const tone = body.data.find((e) => e.uri === toneUri())!;
    expect(tone.frontmatter.metadata).toEqual({ version: "1.0.0" });
  });

  it("refuses a caller without skills:read, a request without uri, and an unknown definition", async () => {
    const headers = await guest({ [owner.defaultSpaceId]: ["mcp:read"] });
    expect((await rest(headers, "/api/mcp/skills")).status).toBe(403);
    expect((await rest(headers, archivePath(toneUri()))).status).toBe(403);
    expect((await rest(ownerHeaders(), "/api/mcp/skills/archive")).status).toBe(400);
    expect((await rest(ownerHeaders(), "/api/mcp/skills?definition=latest")).status).toBe(400);
  });
});

describe("skills/get and resources/read in a chat turn", () => {
  const draftUri = () => `skill://${owner.defaultSpaceId}/skillsext/tone@draft/tone/SKILL.md`;

  /**
   * The chat turn's MCP bearer, minted by the real loopback strategy: no
   * `skills:*` unless `permissions` grants them.
   */
  function turnHeaders(
    skills: InjectedSkills["skills"],
    permissions = ["mcp:read", "chat:write"],
  ): Record<string, string> {
    const token = mintMcpLoopbackToken({
      userId: owner.user.id,
      email: owner.user.email,
      name: owner.user.name,
      orgId: owner.orgId,
      orgRole: "owner",
      permissions,
      injectedSkills: { spaceId: owner.defaultSpaceId, skills },
    });
    return inSpace(
      { Authorization: `Bearer ${token}`, "X-Org-Id": owner.orgId },
      owner.defaultSpaceId,
    );
  }

  async function readText(headers: Record<string, string>, uri: string): Promise<string> {
    const read = await call(headers, "resources/read", { uri });
    return (read.result?.contents as Array<{ text: string }>)[0]!.text;
  }

  /** The same turn holding `skills:read` too, so a refusal does not come from lacking it. */
  const withSkillsRead = (skills: InjectedSkills["skills"]) =>
    turnHeaders(skills, ["mcp:read", "chat:write", "skills:read"]);

  async function expectRefused(headers: Record<string, string>, uri: string): Promise<void> {
    expect((await call(headers, "skills/get", { uri })).error?.code).toBe(-32602);
    expect((await call(headers, "resources/read", { uri })).error?.code).toBe(-32002);
  }

  it("serves the injected published version without skills:read, and refuses its draft", async () => {
    const headers = turnHeaders({ [TONE]: { definition: "published", version: "1.0.0" } });
    const get = await call(headers, "skills/get", { uri: toneUri() });
    expect((get.result?.skill as Entry).frontmatter.metadata).toEqual({ version: "1.0.0" });
    expect(await readText(headers, toneUri())).toContain("\nBody\n");
    await expectRefused(
      withSkillsRead({ [TONE]: { definition: "published", version: "1.0.0" } }),
      draftUri(),
    );
  });

  it("serves the injected draft without skills:read, and refuses the published version", async () => {
    const headers = turnHeaders({ [TONE]: { definition: "draft", lockVersion: 1 } });
    const get = await call(headers, "skills/get", { uri: draftUri() });
    expect((get.result?.skill as Entry).uri).toBe(draftUri());
    expect(await readText(headers, draftUri())).toContain("Draft body");
    await expectRefused(
      withSkillsRead({ [TONE]: { definition: "draft", lockVersion: 1 } }),
      toneUri(),
    );
  });

  it("refuses a skill the turn did not inject", async () => {
    await seedPublishedSkill("@skillsext/other", "other", owner.defaultSpaceId);
    const headers = turnHeaders({ [TONE]: { definition: "published", version: "1.0.0" } });
    await expectRefused(headers, `skill://${owner.defaultSpaceId}/skillsext/other/other/SKILL.md`);
  });

  it("serves an injected system skill as the platform ships it, and refuses its @draft", async () => {
    const system = "@appstrate/system-tone";
    await seedPackage({
      id: system,
      orgId: null,
      source: "system",
      type: "skill",
      draftManifest: { name: system, version: "1.0.0", type: "skill" },
      draftContent: skillMd("system-tone"),
    });
    const headers = turnHeaders({ [system]: { definition: "published", version: null } });
    const dir = `skill://${owner.defaultSpaceId}/appstrate/system-tone`;
    expect(await readText(headers, `${dir}/system-tone/SKILL.md`)).toContain("version: 1.0.0");
    await expectRefused(
      withSkillsRead({ [system]: { definition: "published", version: null } }),
      `${dir}@draft/system-tone/SKILL.md`,
    );
  });
});
