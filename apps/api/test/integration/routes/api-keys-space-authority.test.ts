// SPDX-License-Identifier: Apache-2.0

/**
 * An API key delegates its creator's effective set IN THE KEY'S SPACE
 * (RBAC spec §7.1). Three consequences, one test each — every denial paired
 * with the permitted twin that differs by exactly the thing under test.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedApiKey,
  seedSpace,
  seedSpaceMember,
  seedPackage,
  seedInstalledPackage,
} from "../../helpers/seed.ts";
import { removeSpaceMember } from "../../../src/services/space-members.ts";

const app = getTestApp();

describe("API keys carry their creator's authority in the key's space", () => {
  let owner: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "keyspace" });
    await seedPackage({ orgId: owner.orgId, id: "@keyspace/agent", type: "agent" });
    await seedInstalledPackage(owner.defaultSpaceId, "@keyspace/agent");
  });

  it("a builder cannot mint api-keys:create, and a space admin can", async () => {
    const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
    const builder = await createTestUser();
    await addOrgMember(owner.orgId, builder.id, "member");
    await seedSpaceMember({ spaceId: closed.id, userId: builder.id, presetRole: "builder" });

    const mint = (cookie: string) =>
      app.request("/api/api-keys", {
        method: "POST",
        headers: {
          ...authHeaders({ ...owner, cookie }, { "X-Space-Id": closed.id }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "k" }),
      });

    // `api-keys:create` is preset `admin`'s, so the builder cannot even reach
    // the route — the guard reads the same set the mint would delegate.
    expect((await mint(builder.cookie)).status).toBe(403);

    const spaceAdmin = await createTestUser();
    await addOrgMember(owner.orgId, spaceAdmin.id, "member");
    await seedSpaceMember({ spaceId: closed.id, userId: spaceAdmin.id, presetRole: "admin" });
    expect((await mint(spaceAdmin.cookie)).status).toBe(201);
  });

  it("available-scopes is the caller's effective set — both halves", async () => {
    const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
    const spaceAdmin = await createTestUser();
    await addOrgMember(owner.orgId, spaceAdmin.id, "member");
    await seedSpaceMember({ spaceId: closed.id, userId: spaceAdmin.id, presetRole: "admin" });

    const scopesFor = async (cookie: string) => {
      const res = await app.request("/api/api-keys/available-scopes", {
        headers: authHeaders({ ...owner, cookie }, { "X-Space-Id": closed.id }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: string[] }).data;
    };

    const asSpaceAdmin = await scopesFor(spaceAdmin.cookie);
    // The SPACE half comes from the preset: they run this space.
    expect(asSpaceAdmin).toContain("agents:write");
    // The ORG half comes from the org role, which is `member`: infrastructure
    // stays out of reach, and running a space does not change that.
    expect(asSpaceAdmin).not.toContain("models:write");
    expect(asSpaceAdmin).not.toContain("spaces:write");

    // Control: the owner, in the same space, holds both halves.
    const asOwner = await scopesFor(owner.cookie);
    expect(asOwner).toContain("agents:write");
    expect(asOwner).toContain("models:write");
    expect(asOwner).toContain("spaces:write");
  });

  it("a key whose creator lost the space 403s where it used to work", async () => {
    const closed = await seedSpace({ orgId: owner.orgId, visibility: "closed" });
    await seedPackage({ orgId: owner.orgId, id: "@keyspace/other", type: "agent" });
    await seedInstalledPackage(closed.id, "@keyspace/other");

    const creator = await createTestUser();
    await addOrgMember(owner.orgId, creator.id, "member");
    await seedSpaceMember({ spaceId: closed.id, userId: creator.id, presetRole: "operator" });

    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: closed.id,
      createdBy: creator.id,
      scopes: ["agents:read"],
    });
    const read = () =>
      app.request("/api/agents", { headers: { Authorization: `Bearer ${key.rawKey}` } });

    expect((await read()).status).toBe(200);

    // Live ceiling, no revocation sweep: the row goes, the key stops working.
    await removeSpaceMember(closed.id, creator.id);
    expect((await read()).status).toBe(403);
  });

  it("integrations:configure is refused at mint for every creator", async () => {
    const res = await app.request("/api/api-keys", {
      method: "POST",
      headers: { ...authHeaders(owner), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "k", scopes: ["integrations:configure"] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain("integrations:configure");

    // Control: the owner CAN mint the grantable sibling, so the 400 is about
    // the scope and not about the owner.
    const ok = await app.request("/api/api-keys", {
      method: "POST",
      headers: { ...authHeaders(owner), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "k2", scopes: ["integrations:install"] }),
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { scopes: string[] }).scopes).toEqual(["integrations:install"]);
  });
});
