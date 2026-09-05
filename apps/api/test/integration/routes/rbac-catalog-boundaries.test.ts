// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { packages, spaceMembers, spacePackages } from "@appstrate/db/schema";
import { zipArtifact } from "@appstrate/core/zip";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedApiKey,
  seedInstalledPackage,
  seedPackage,
  seedSpace,
  seedSpaceMember,
  seedSpaceRole,
} from "../../helpers/seed.ts";
import { createInvitation } from "../../../src/services/invitations.ts";

const app = getTestApp();
interface OrgDetail {
  members: unknown[];
  invitations: unknown[];
}
interface Library {
  spaces: { id: string }[];
  packages: { skill: { id: string; installed_in: string[] }[] };
}

const ID = "@catalog/secret";
const content = "---\nname: secret\ndescription: Private skill\n---\n\nPrivate instructions";
const manifest = { name: ID, version: "0.1.0", type: "skill", description: "Private description" };

let ctx: TestContext;
let headers: Record<string, string>;
let guestId: string;
let privateId: string;

async function installIn(spaceId: string) {
  await seedInstalledPackage(spaceId, ID);
}

async function skill() {
  await seedPackage({
    id: ID,
    orgId: ctx.orgId,
    createdBy: ctx.user.id,
    type: "skill",
    draftManifest: manifest,
    draftContent: content,
  });
}

async function keyHeaders(scopes: string[]) {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    createdBy: ctx.user.id,
    scopes,
  });
  return { Authorization: `Bearer ${key.rawKey}` };
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "catalog" });
  const guest = await createTestUser();
  guestId = guest.id;
  await addOrgMember(ctx.orgId, guest.id, "guest");
  await seedSpaceMember({ spaceId: ctx.defaultSpaceId, userId: guest.id, presetRole: "builder" });
  const hidden = await seedSpace({
    orgId: ctx.orgId,
    name: "Confidential space",
    visibility: "private",
  });
  privateId = hidden.id;
  headers = { ...authHeaders(ctx), Cookie: guest.cookie };
  await skill();
});

describe("organization detail privacy", () => {
  it("returns no directory or invitations to a guest", async () => {
    await createInvitation({
      orgId: ctx.orgId,
      email: "secret@example.com",
      role: "member",
      invitedBy: ctx.user.id,
      spaceAssignments: [],
    });
    const response = await app.request(`/api/orgs/${ctx.orgId}`, { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as OrgDetail;
    expect(body.members).toEqual([]);
    expect(body.invitations).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("secret@example.com");
  });

  it("exposes invitations only with invite authority and applies the key ceiling", async () => {
    await createInvitation({
      orgId: ctx.orgId,
      email: "secret@example.com",
      role: "member",
      invitedBy: ctx.user.id,
      spaceAssignments: [],
    });
    const owner = await app.request(`/api/orgs/${ctx.orgId}`, { headers: authHeaders(ctx) });
    expect(((await owner.json()) as OrgDetail).invitations).toHaveLength(1);
    const restricted = await app.request(`/api/orgs/${ctx.orgId}`, {
      headers: await keyHeaders(["spaces:read"]),
    });
    expect(restricted.status).toBe(200);
    const body = (await restricted.json()) as OrgDetail;
    expect(body.members).toEqual([]);
    expect(body.invitations).toEqual([]);
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    const memberResponse = await app.request(`/api/orgs/${ctx.orgId}`, {
      headers: { ...authHeaders(ctx), Cookie: member.cookie },
    });
    const memberBody = (await memberResponse.json()) as OrgDetail;
    expect(memberBody.members.length).toBeGreaterThan(0);
    expect(memberBody.invitations).toEqual([]);
  });
});

describe("library visibility", () => {
  it("hides private and inaccessible closed spaces and their package metadata", async () => {
    await installIn(privateId);
    await seedSpace({ orgId: ctx.orgId, name: "Closed space", visibility: "closed" });
    const response = await app.request("/api/library", { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Library;
    expect(body.spaces.map((space: { id: string }) => space.id)).toEqual([ctx.defaultSpaceId]);
    expect(body.packages.skill).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(ID);
    expect(JSON.stringify(body)).not.toContain(privateId);
  });

  it("lists only readable types and installation mappings for accessible spaces", async () => {
    await installIn(ctx.defaultSpaceId);
    await installIn(privateId);
    const response = await app.request("/api/library", { headers });
    const body = (await response.json()) as Library;
    expect(body.packages.skill[0]?.installed_in).toEqual([ctx.defaultSpaceId]);
    const role = await seedSpaceRole({ orgId: ctx.orgId, permissions: ["agents:read"] });
    await db
      .update(spaceMembers)
      .set({ presetRole: null, customRoleId: role.id })
      .where(eq(spaceMembers.userId, guestId));
    const restricted = await app.request("/api/library", { headers });
    expect(((await restricted.json()) as Library).packages.skill).toEqual([]);
  });

  it("filters installed package metadata by the credential's type read scopes", async () => {
    await installIn(ctx.defaultSpaceId);
    const path = `/api/spaces/${ctx.defaultSpaceId}/packages`;
    const restricted = await app.request(path, { headers: await keyHeaders(["spaces:read"]) });
    expect(restricted.status).toBe(200);
    expect(((await restricted.json()) as { data: unknown[] }).data).toEqual([]);
    const readable = await app.request(path, {
      headers: await keyHeaders(["spaces:read", "skills:read"]),
    });
    expect(readable.status).toBe(200);
    expect(((await readable.json()) as { data: { packageId: string }[] }).data[0]?.packageId).toBe(
      ID,
    );
  });

  it("retains owner uninstalled catalog access but pins an owner API key to its space", async () => {
    const owner = await app.request("/api/library", { headers: authHeaders(ctx) });
    expect(((await owner.json()) as Library).packages.skill[0]?.id).toBe(ID);
    const restricted = await app.request("/api/library", {
      headers: await keyHeaders(["spaces:read", "skills:read"]),
    });
    const body = (await restricted.json()) as Library;
    expect(body.spaces.map((space: { id: string }) => space.id)).toEqual([ctx.defaultSpaceId]);
    expect(body.packages.skill).toEqual([]);
  });
});

describe("shared package authority", () => {
  it("denies hidden package reads, versions, mutations and guessed installation without changing state", async () => {
    await installIn(privateId);
    for (const [method, path] of [
      ["GET", `/api/packages/skills/${ID}`],
      ["GET", `/api/packages/skills/${ID}/versions`],
      ["GET", `/api/packages/skills/${ID}/versions/info`],
      ["GET", `/api/packages/skills/${ID}/versions/0.1.0`],
      ["DELETE", `/api/packages/skills/${ID}`],
      ["PUT", `/api/packages/skills/${ID}`],
      ["POST", `/api/packages/skills/${ID}/versions`],
      ["POST", `/api/packages/skills/${ID}/versions/0.1.0/restore`],
      ["DELETE", `/api/packages/skills/${ID}/versions/0.1.0`],
    ]) {
      const response = await app.request(path!, { method, headers });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    const install = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ packageId: ID }),
    });
    expect(install.status).toBe(404);
    expect(await db.select().from(packages).where(eq(packages.id, ID))).toHaveLength(1);
  });

  it("allows a builder to delete a package installed only in their space", async () => {
    await installIn(ctx.defaultSpaceId);
    const response = await app.request(`/api/packages/skills/${ID}`, { method: "DELETE", headers });
    expect(response.status).toBe(204);
    expect(await db.select().from(packages).where(eq(packages.id, ID))).toHaveLength(0);
  });

  it("requires deletion authority in every shared installation, not only visibility", async () => {
    await installIn(ctx.defaultSpaceId);
    await installIn(privateId);
    await seedSpaceMember({ spaceId: privateId, userId: guestId, presetRole: "viewer" });
    const response = await app.request(`/api/packages/skills/${ID}`, { method: "DELETE", headers });
    expect(response.status).toBe(403);
    await db
      .update(spaceMembers)
      .set({ presetRole: "builder" })
      .where(eq(spaceMembers.spaceId, privateId));
    const allowed = await app.request(`/api/packages/skills/${ID}`, { method: "DELETE", headers });
    expect(allowed.status).toBe(204);
  });

  it("cannot use an owner key in A to mutate a package shared with B", async () => {
    await installIn(ctx.defaultSpaceId);
    await installIn(privateId);
    const response = await app.request(`/api/packages/skills/${ID}`, {
      method: "DELETE",
      headers: await keyHeaders(["skills:delete"]),
    });
    expect(response.status).toBe(403);
  });

  it("preserves write-only credentials for packages installed exclusively in their pinned space", async () => {
    await installIn(ctx.defaultSpaceId);
    const response = await app.request(`/api/packages/skills/${ID}`, {
      method: "DELETE",
      headers: await keyHeaders(["skills:delete"]),
    });
    expect(response.status).toBe(204);
  });

  it("refuses a force import of a hidden existing package before it writes", async () => {
    await installIn(privateId);
    const archive = zipArtifact({
      "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
      "SKILL.md": new TextEncoder().encode(content),
    });
    const form = new FormData();
    form.append("file", new File([archive], "secret.afps"));
    form.append("force", "true");
    const response = await app.request("/api/packages/import", {
      method: "POST",
      headers,
      body: form,
    });
    expect(response.status, await response.clone().text()).toBe(404);
    const [row] = await db.select().from(packages).where(eq(packages.id, ID));
    expect(row?.draftContent).toBe(content);
  });

  it("imports a new skill with only skills:write, then denies an inaccessible overwrite with that credential", async () => {
    const authorization = await keyHeaders(["skills:write"]);
    const archiveFor = (id: string) =>
      zipArtifact({
        "manifest.json": new TextEncoder().encode(JSON.stringify({ ...manifest, name: id })),
        "SKILL.md": new TextEncoder().encode(content),
      });
    const own = new FormData();
    own.append("file", new File([archiveFor("@catalog/own")], "own.afps"));
    const created = await app.request("/api/packages/import", {
      method: "POST",
      headers: authorization,
      body: own,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    await installIn(privateId);
    const hidden = new FormData();
    hidden.append("file", new File([archiveFor(ID)], "hidden.afps"));
    const overwritten = await app.request("/api/packages/import?force=true", {
      method: "POST",
      headers: authorization,
      body: hidden,
    });
    expect(overwritten.status).toBe(404);
  });

  it("preserves unchanged dependency references for a write-only credential", async () => {
    await installIn(privateId);
    const agentId = "@catalog/editable";
    await seedPackage({
      id: agentId,
      orgId: ctx.orgId,
      type: "agent",
      draftManifest: {
        name: agentId,
        type: "agent",
        version: "0.1.0",
        schema_version: "0.1",
        display_name: "Editable",
        description: "An editable agent",
        dependencies: { skills: { [ID]: "^0.1.0" } },
      },
      draftContent: "Prompt",
    });
    await seedInstalledPackage(ctx.defaultSpaceId, agentId);
    const response = await app.request(`/api/agents/${agentId}/skills`, {
      method: "PUT",
      headers: { ...(await keyHeaders(["agents:write"])), "Content-Type": "application/json" },
      body: JSON.stringify({ skillIds: [ID] }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it("does not fork another organization's private package without source membership", async () => {
    const source = await createTestContext({ orgSlug: "source" });
    await seedPackage({ id: "@source/private", orgId: source.orgId, type: "skill" });
    const response = await app.request("/api/packages/@source/private/fork", {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(response.status).toBe(404);
  });

  it("uses the stored package type for an existing bundle root's install permission", async () => {
    await db.update(packages).set({ type: "integration" }).where(eq(packages.id, ID));
    await installIn(privateId);
    const role = await seedSpaceRole({
      orgId: ctx.orgId,
      permissions: ["skills:write", "integrations:write", "integrations:read"],
    });
    await db
      .update(spaceMembers)
      .set({ presetRole: null, customRoleId: role.id })
      .where(eq(spaceMembers.userId, guestId));
    await seedSpaceMember({
      spaceId: privateId,
      userId: guestId,
      presetRole: null,
      customRoleId: role.id,
    });
    const archive = zipArtifact({
      "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
      "SKILL.md": new TextEncoder().encode(content),
    });
    const form = new FormData();
    form.append("file", new File([archive], "secret.afps"));
    const response = await app.request("/api/packages/import-bundle", {
      method: "POST",
      headers,
      body: form,
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(
      await db.select().from(spacePackages).where(eq(spacePackages.packageId, ID)),
    ).toHaveLength(1);
  });

  it("rejects a carried hidden package during bundle authorization before any import write", async () => {
    await installIn(privateId);
    const archive = zipArtifact({
      "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
      "SKILL.md": new TextEncoder().encode(content),
    });
    const form = new FormData();
    form.append("file", new File([archive], "secret.afps"));
    const response = await app.request("/api/packages/import-bundle", {
      method: "POST",
      headers,
      body: form,
    });
    expect(response.status, await response.clone().text()).toBe(404);
    const [row] = await db.select().from(packages).where(eq(packages.id, ID));
    expect(row?.draftContent).toBe(content);
  });

  it("refuses hidden dependencies before creating an agent", async () => {
    await installIn(privateId);
    const response = await app.request("/api/packages/agents", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: {
          name: "@catalog/leak",
          display_name: "Leak",
          description: "Try hidden dependency",
          schema_version: "0.1",
          version: "0.1.0",
          type: "agent",
          dependencies: { skills: { [ID]: "^0.1.0" } },
        },
        content: "Read the skill",
      }),
    });
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await db.select().from(packages).where(eq(packages.id, "@catalog/leak"))).toHaveLength(
      0,
    );
  });
});
