// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { packages, spaceMembers, spacePackages } from "@appstrate/db/schema";
import { zipArtifact } from "@appstrate/core/zip";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { assertDbCount, getDbRow } from "../../helpers/assertions.ts";
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
/** The guest: org `guest`, explicit `builder` in the default space. */
let headers: Record<string, string>;
let guestId: string;
let privateId: string;

const installIn = (spaceId: string) => seedInstalledPackage(spaceId, ID);

/**
 * Give the seeded skill a home space — the ONE authority over its draft
 * (`packages.home_space_id`). The fixture seeds it without one on purpose: no
 * home is the ORG CATALOG, which is the shape of an admin-level import and of
 * every row that predates the column.
 */
const homeIn = (spaceId: string | null) =>
  db.update(packages).set({ homeSpaceId: spaceId }).where(eq(packages.id, ID));

async function keyHeaders(scopes: string[]) {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    createdBy: ctx.user.id,
    scopes,
  });
  return { Authorization: `Bearer ${key.rawKey}` };
}

/** A pending invitation whose email must never reach a caller without invite authority. */
const seedSecretInvitation = () =>
  createInvitation({
    orgId: ctx.orgId,
    email: "secret@example.com",
    role: "member",
    invitedBy: ctx.user.id,
    spaceAssignments: [],
  });

/** Swap the guest's default-space row from the `builder` preset to a custom bundle. */
async function assignGuestCustomRole(permissions: string[]) {
  const role = await seedSpaceRole({ orgId: ctx.orgId, permissions });
  await db
    .update(spaceMembers)
    .set({ presetRole: null, customRoleId: role.id })
    .where(eq(spaceMembers.userId, guestId));
  return role;
}

const orgDetail = async (h: Record<string, string>) => {
  const res = await app.request(`/api/orgs/${ctx.orgId}`, { headers: h });
  expect(res.status).toBe(200);
  return (await res.json()) as OrgDetail;
};

const library = async (h: Record<string, string>) => {
  const res = await app.request("/api/library", { headers: h });
  expect(res.status).toBe(200);
  return (await res.json()) as Library;
};

const deleteSkill = (h: Record<string, string>) =>
  app.request(`/api/packages/skills/${ID}`, { method: "DELETE", headers: h });

/** A single-skill `.afps` archive as an upload form, `manifest.name` overridable. */
function skillArchiveForm(id = ID, fields: Record<string, string> = {}) {
  const archive = zipArtifact({
    "manifest.json": new TextEncoder().encode(JSON.stringify({ ...manifest, name: id })),
    "SKILL.md": new TextEncoder().encode(content),
  });
  const form = new FormData();
  form.append("file", new File([archive], "secret.afps"));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

const importArchive = (path: string, form: FormData, h: Record<string, string>) =>
  app.request(path, { method: "POST", headers: h, body: form });

/** The seeded skill is still on disk with its original draft — the refusal wrote nothing. */
const expectSecretUntouched = async () =>
  expect((await getDbRow(packages, eq(packages.id, ID))).draftContent).toBe(content);

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
  await seedPackage({
    id: ID,
    orgId: ctx.orgId,
    createdBy: ctx.user.id,
    type: "skill",
    draftManifest: manifest,
    draftContent: content,
  });
});

describe("organization detail privacy", () => {
  it("returns no directory or invitations to a guest", async () => {
    await seedSecretInvitation();
    const body = await orgDetail(headers);
    expect(body.members).toEqual([]);
    expect(body.invitations).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("secret@example.com");
  });

  it("exposes invitations only with invite authority and applies the key ceiling", async () => {
    await seedSecretInvitation();
    expect((await orgDetail(authHeaders(ctx))).invitations).toHaveLength(1);

    const restricted = await orgDetail(await keyHeaders(["spaces:read"]));
    expect(restricted.members).toEqual([]);
    expect(restricted.invitations).toEqual([]);

    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    const asMember = await orgDetail({ ...authHeaders(ctx), Cookie: member.cookie });
    expect(asMember.members.length).toBeGreaterThan(0);
    expect(asMember.invitations).toEqual([]);
  });
});

describe("library visibility", () => {
  it("hides private and inaccessible closed spaces and their package metadata", async () => {
    await installIn(privateId);
    await seedSpace({ orgId: ctx.orgId, name: "Closed space", visibility: "closed" });
    const body = await library(headers);
    expect(body.spaces.map((space) => space.id)).toEqual([ctx.defaultSpaceId]);
    expect(body.packages.skill).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(ID);
    expect(JSON.stringify(body)).not.toContain(privateId);
  });

  it("lists only readable types and installation mappings for accessible spaces", async () => {
    await installIn(ctx.defaultSpaceId);
    await installIn(privateId);
    expect((await library(headers)).packages.skill[0]?.installed_in).toEqual([ctx.defaultSpaceId]);
    await assignGuestCustomRole(["agents:read"]);
    expect((await library(headers)).packages.skill).toEqual([]);
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
    expect((await library(authHeaders(ctx))).packages.skill[0]?.id).toBe(ID);
    const body = await library(await keyHeaders(["spaces:read", "skills:read"]));
    expect(body.spaces.map((space) => space.id)).toEqual([ctx.defaultSpaceId]);
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
    await assertDbCount(packages, eq(packages.id, ID), 1);
  });

  it("refuses a builder on a package with no home, and admits them once it has theirs", async () => {
    await installIn(ctx.defaultSpaceId);
    // No home = the org catalog: the guest is a builder where it is installed,
    // and that is deliberately not enough.
    expect((await deleteSkill(headers)).status).toBe(403);
    await assertDbCount(packages, eq(packages.id, ID), 1);

    await homeIn(ctx.defaultSpaceId);
    expect((await deleteSkill(headers)).status).toBe(204);
    await assertDbCount(packages, eq(packages.id, ID), 0);
  });

  it("authorizes deletion from the home space alone, whatever other spaces hold it", async () => {
    await homeIn(ctx.defaultSpaceId);
    await installIn(ctx.defaultSpaceId);
    await installIn(privateId);
    // A `viewer` row in the other installation used to veto the delete. The
    // home is the authority now, so it does not.
    await seedSpaceMember({ spaceId: privateId, userId: guestId, presetRole: "viewer" });
    expect((await deleteSkill(headers)).status).toBe(204);
  });

  it("refuses a builder of another installation once the home moves away", async () => {
    await homeIn(privateId);
    await installIn(ctx.defaultSpaceId);
    await installIn(privateId);
    // Reachable through its installation in their own space — so 403, not 404 —
    // but governed elsewhere.
    expect((await deleteSkill(headers)).status).toBe(403);
    await assertDbCount(packages, eq(packages.id, ID), 1);
  });

  it("tells a write-only key nothing about a package homed elsewhere", async () => {
    await homeIn(privateId);
    await installIn(ctx.defaultSpaceId);
    await installIn(privateId);
    // 404 because `skills:delete` alone holds `skills:read` in NO space, so the
    // key may not know this id exists at all — the home never enters it. The
    // sibling below is the case where the home IS the reason.
    expect((await deleteSkill(await keyHeaders(["skills:delete"]))).status).toBe(404);
  });

  it("cannot use a key pinned to A to mutate a package homed in B", async () => {
    await homeIn(privateId);
    await installIn(ctx.defaultSpaceId);
    await installIn(privateId);
    // With `skills:read` the key sees the package through the installation in
    // its own pinned space — so the refusal owes the caller a 403 — and the
    // home, in a space the key cannot reach, is what refuses it.
    expect((await deleteSkill(await keyHeaders(["skills:read", "skills:delete"]))).status).toBe(
      403,
    );
    await assertDbCount(packages, eq(packages.id, ID), 1);
  });

  it("preserves write-only credentials for packages homed in their pinned space", async () => {
    await homeIn(ctx.defaultSpaceId);
    await installIn(ctx.defaultSpaceId);
    expect((await deleteSkill(await keyHeaders(["skills:delete"]))).status).toBe(204);
  });

  it("refuses a force import of a hidden existing package before it writes", async () => {
    await installIn(privateId);
    const form = skillArchiveForm(ID, { force: "true" });
    const response = await importArchive("/api/packages/import", form, headers);
    expect(response.status, await response.clone().text()).toBe(404);
    await expectSecretUntouched();
  });

  it("imports a new skill with only skills:write, then denies an inaccessible overwrite with that credential", async () => {
    const authorization = await keyHeaders(["skills:write"]);
    const created = await importArchive(
      "/api/packages/import",
      skillArchiveForm("@catalog/own"),
      authorization,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    await installIn(privateId);
    const overwritten = await importArchive(
      "/api/packages/import?force=true",
      skillArchiveForm(ID),
      authorization,
    );
    expect(overwritten.status).toBe(404);
  });

  it("preserves unchanged dependency references for a write-only credential", async () => {
    await installIn(privateId);
    const agentId = "@catalog/editable";
    await seedPackage({
      id: agentId,
      orgId: ctx.orgId,
      homeSpaceId: ctx.defaultSpaceId,
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
    const role = await assignGuestCustomRole([
      "skills:write",
      "integrations:write",
      "integrations:read",
    ]);
    await seedSpaceMember({
      spaceId: privateId,
      userId: guestId,
      presetRole: null,
      customRoleId: role.id,
    });
    const response = await importArchive(
      "/api/packages/import-bundle",
      skillArchiveForm(),
      headers,
    );
    expect(response.status, await response.clone().text()).toBe(403);
    await assertDbCount(spacePackages, eq(spacePackages.packageId, ID), 1);
  });

  it("rejects a carried hidden package during bundle authorization before any import write", async () => {
    await installIn(privateId);
    const response = await importArchive(
      "/api/packages/import-bundle",
      skillArchiveForm(),
      headers,
    );
    expect(response.status, await response.clone().text()).toBe(404);
    await expectSecretUntouched();
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
    await assertDbCount(packages, eq(packages.id, "@catalog/leak"), 0);
  });
});
