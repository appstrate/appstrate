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
  seedSpacePackage,
  seedPackageShare,
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
interface Placement {
  space_id: string;
  via: "home" | "shared" | "system";
  state: "active" | "inactive" | "none";
  shared_by: { user_id: string; name: string } | null;
}
interface Library {
  spaces: { id: string }[];
  packages: { skill: { id: string; placements: Placement[] }[] };
}

const ID = "@catalog/secret";
const content = "---\nname: secret\ndescription: Private skill\n---\n\nPrivate instructions";
const manifest = { name: ID, version: "0.1.0", type: "skill", description: "Private description" };

let ctx: TestContext;
/** The guest: org `guest`, explicit `builder` in the default space. */
let headers: Record<string, string>;
let guestId: string;
let privateId: string;

const activateIn = (spaceId: string) => seedSpacePackage(spaceId, ID);

/**
 * PLACE the skill in a space and activate it there — the only shape a non-home
 * placement can have (RBAC spec §6.9): a package is present in a space through
 * its home or a `package_shares` row, and a `space_packages` row outside the
 * home is always backed by one (the activation door writes it, and
 * `scripts/migration/0016` wrote it for every row that predates the rule).
 * `activateIn` alone is kept for the cases that assert the refusal an UNPLACED
 * row gets.
 */
const placeIn = async (spaceId: string) => {
  await seedPackageShare(spaceId, ID);
  await seedSpacePackage(spaceId, ID);
};

/**
 * MOVE the seeded skill's home — the ONE authority over its draft
 * (`packages.home_space_id`). The fixture homes it in the CONFIDENTIAL space on
 * purpose: every organization package has a home
 * (`packages_org_package_has_home`), so "not placed where the caller looks"
 * means homed somewhere they do not reach, and the confidential space is one
 * the guest is not a member of while the org owner reaches it like any other
 * team space.
 */
const homeIn = (spaceId: string) =>
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
  const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/library`, { headers: h });
  expect(res.status).toBe(200);
  return (await res.json()) as Library;
};

const deleteSkill = (h: Record<string, string>) =>
  app.request(`/api/packages/skills/${ID}`, { method: "DELETE", headers: h });

/** Use the current token so these cases isolate the authority gate. */
const saveFiles = async (h: Record<string, string>) => {
  const [row] = await db
    .select({ lockVersion: packages.lockVersion })
    .from(packages)
    .where(eq(packages.id, ID));
  return app.request(`/api/packages/skills/${ID}`, {
    method: "PUT",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({
      lock_version: row!.lockVersion,
      operations: [{ op: "write", path: "notes.md", text: "x" }],
    }),
  });
};

/** Every route whose authority is the package's, with the init each one needs. */
function routesUnderAuthority(): [
  string,
  string,
  { headers?: Record<string, string>; body?: string }?,
][] {
  return [
    ["GET", `/api/packages/skills/${ID}`],
    ["GET", `/api/packages/skills/${ID}/versions`],
    ["GET", `/api/packages/skills/${ID}/versions/info`],
    ["GET", `/api/packages/skills/${ID}/versions/0.1.0`],
    ["DELETE", `/api/packages/skills/${ID}`],
    ["PUT", `/api/packages/skills/${ID}`],
    ["POST", `/api/packages/skills/${ID}/versions`],
    ["POST", `/api/packages/skills/${ID}/versions/0.1.0/restore`],
    ["DELETE", `/api/packages/skills/${ID}/versions/0.1.0`],
    [
      "PUT",
      `/api/packages/skills/${ID}`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lock_version: 0,
          operations: [{ op: "write", path: "notes.md", text: "x" }],
        }),
      },
    ],
  ];
}

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
    homeSpaceId: privateId,
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

describe("organization library administration", () => {
  it("reserves the organization library to owners and admins", async () => {
    expect((await app.request("/api/library", { headers: authHeaders(ctx) })).status).toBe(200);
    for (const role of ["admin", "member", "guest"] as const) {
      const user = await createTestUser();
      await addOrgMember(ctx.orgId, user.id, role);
      const res = await app.request("/api/library", {
        headers: { ...authHeaders(ctx), Cookie: user.cookie },
      });
      expect(res.status).toBe(role === "admin" ? 200 : 403);
    }
    expect(
      (
        await app.request("/api/library", {
          headers: await keyHeaders(["spaces:read", "skills:read"]),
        })
      ).status,
    ).toBe(403);
  });

  it("does not let an owner previewing a member regain organization administration", async () => {
    const res = await app.request("/api/library", {
      headers: { ...authHeaders(ctx), "X-View-As": "org_role=member" },
    });
    expect(res.status).toBe(403);
  });

  it("discovers readable candidates without revealing other spaces' installation state", async () => {
    const source = await seedSpace({ orgId: ctx.orgId, name: "Source", visibility: "closed" });
    await seedSpaceMember({ spaceId: source.id, userId: guestId, presetRole: "viewer" });
    // Homed in the space the guest only READS, and OFFERED to the one they
    // build in: a candidate they may install, placed nowhere else they can see.
    await homeIn(source.id);
    await seedPackageShare(ctx.defaultSpaceId, ID);
    const body = await library(headers);
    expect(body.spaces.map((space) => space.id)).toEqual([ctx.defaultSpaceId]);
    // An untaken offer is a PLACEMENT with `state: "none"` on the package's own
    // row — one row, one switch. Nothing about the SOURCE space leaks with it:
    // the only space id named is the caller's own.
    expect(body.packages.skill[0]?.placements).toEqual([
      { space_id: ctx.defaultSpaceId, via: "shared", state: "none", shared_by: null },
    ]);
    const activated = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ packageId: ID }),
    });
    expect(activated.status, await activated.clone().text()).toBe(201);
    const after = await library(headers);
    expect(after.packages.skill[0]?.placements).toMatchObject([
      { space_id: ctx.defaultSpaceId, via: "shared", state: "active" },
    ]);
  });

  it("keeps the local package view available to a builder and pins keys to their space", async () => {
    await homeIn(ctx.defaultSpaceId);
    await activateIn(ctx.defaultSpaceId);
    const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/library`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Library;
    expect(body.spaces.map((space) => space.id)).toEqual([ctx.defaultSpaceId]);
    expect(body.packages.skill[0]?.id).toBe(ID);
    const denied = await app.request(`/api/spaces/${privateId}/library`, {
      headers: await keyHeaders(["spaces:read", "skills:read"]),
    });
    expect(denied.status).toBe(403);
  });
});

describe("library visibility", () => {
  it("hides private and inaccessible closed spaces and their package metadata", async () => {
    await activateIn(privateId);
    await seedSpace({ orgId: ctx.orgId, name: "Closed space", visibility: "closed" });
    const body = await library(headers);
    expect(body.spaces.map((space) => space.id)).toEqual([ctx.defaultSpaceId]);
    expect(body.packages.skill).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(ID);
    expect(JSON.stringify(body)).not.toContain(privateId);
  });

  it("lists only readable types and placements for accessible spaces", async () => {
    await homeIn(ctx.defaultSpaceId);
    await activateIn(ctx.defaultSpaceId);
    await placeIn(privateId);
    expect((await library(headers)).packages.skill[0]?.placements.map((p) => p.space_id)).toEqual([
      ctx.defaultSpaceId,
    ]);
    await assignGuestCustomRole(["agents:read"]);
    expect((await library(headers)).packages.skill).toEqual([]);
  });

  it("filters placement metadata by the credential's type read scopes", async () => {
    // `placeIn`, not `activateIn`: the claim here is about the credential's
    // type scopes, so the package has to be genuinely placed — a row nothing
    // places is filtered for a reason this test does not mean to assert.
    await placeIn(ctx.defaultSpaceId);
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
    await activateIn(privateId);
    for (const [method, path, init] of routesUnderAuthority()) {
      const response = await app.request(path, {
        method,
        ...init,
        headers: { ...headers, ...init?.headers },
      });
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

  it("refuses a builder whose space merely HOLDS the package, and admits them once it is homed there", async () => {
    await placeIn(ctx.defaultSpaceId);
    // Homed in the confidential space: the guest is a builder where the package
    // is placed, and that is deliberately not enough — a placement consumes a
    // package, it never gains a say over it.
    expect((await deleteSkill(headers)).status).toBe(403);
    await assertDbCount(packages, eq(packages.id, ID), 1);

    await homeIn(ctx.defaultSpaceId);
    expect((await deleteSkill(headers)).status).toBe(204);
    await assertDbCount(packages, eq(packages.id, ID), 0);
  });

  it("authorizes file edits from the home even when another installation is read-only", async () => {
    await homeIn(ctx.defaultSpaceId);
    await activateIn(ctx.defaultSpaceId);
    await activateIn(privateId);
    await seedSpaceMember({ spaceId: privateId, userId: guestId, presetRole: "viewer" });
    expect((await saveFiles(headers)).status).toBe(200);
    await homeIn(privateId);
    expect((await saveFiles(headers)).status).toBe(403);
  });

  it("authorizes deletion from the home space alone, whatever other spaces hold it", async () => {
    await homeIn(ctx.defaultSpaceId);
    await activateIn(ctx.defaultSpaceId);
    await activateIn(privateId);
    // The home is the authority, so a `viewer` row in another installation
    // does not veto the delete — conjoining every installation would let the
    // weakest of them decide.
    await seedSpaceMember({ spaceId: privateId, userId: guestId, presetRole: "viewer" });
    expect((await deleteSkill(headers)).status).toBe(204);
  });

  it("refuses a builder of another placement once the home moves away", async () => {
    await homeIn(privateId);
    await placeIn(ctx.defaultSpaceId);
    await activateIn(privateId);
    // Reachable through the offer to their own space — so 403, not 404 — but
    // governed elsewhere.
    expect((await deleteSkill(headers)).status).toBe(403);
    await assertDbCount(packages, eq(packages.id, ID), 1);
  });

  it("tells a write-only key nothing about a package homed elsewhere", async () => {
    await homeIn(privateId);
    await placeIn(ctx.defaultSpaceId);
    await activateIn(privateId);
    // 404 because `skills:delete` alone holds `skills:read` in NO space, so the
    // key may not know this id exists at all — the home never enters it. The
    // sibling below is the case where the home IS the reason.
    expect((await deleteSkill(await keyHeaders(["skills:delete"]))).status).toBe(404);
  });

  it("cannot use a key pinned to A to mutate a package homed in B", async () => {
    await homeIn(privateId);
    await placeIn(ctx.defaultSpaceId);
    await activateIn(privateId);
    // With `skills:read` the key sees the package through the offer to its own
    // pinned space — so the refusal owes the caller a 403 — and the home, in a
    // space the key cannot reach, is what refuses it.
    expect((await deleteSkill(await keyHeaders(["skills:read", "skills:delete"]))).status).toBe(
      403,
    );
    await assertDbCount(packages, eq(packages.id, ID), 1);
  });

  it("preserves write-only credentials for packages homed in their pinned space", async () => {
    await homeIn(ctx.defaultSpaceId);
    await activateIn(ctx.defaultSpaceId);
    expect((await deleteSkill(await keyHeaders(["skills:delete"]))).status).toBe(204);
  });

  it("refuses a force import of a hidden existing package before it writes", async () => {
    await activateIn(privateId);
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
    await activateIn(privateId);
    const overwritten = await importArchive(
      "/api/packages/import?force=true",
      skillArchiveForm(ID),
      authorization,
    );
    expect(overwritten.status).toBe(404);
  });

  it("preserves unchanged dependency references for a write-only credential", async () => {
    await activateIn(privateId);
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
    await seedSpacePackage(ctx.defaultSpaceId, agentId);
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
    await placeIn(privateId);
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
    await activateIn(privateId);
    const response = await importArchive(
      "/api/packages/import-bundle",
      skillArchiveForm(),
      headers,
    );
    expect(response.status, await response.clone().text()).toBe(404);
    await expectSecretUntouched();
  });

  it("refuses hidden dependencies before creating an agent", async () => {
    await activateIn(privateId);
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
