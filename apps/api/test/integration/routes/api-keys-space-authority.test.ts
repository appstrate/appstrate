// SPDX-License-Identifier: Apache-2.0

/**
 * An API key delegates its creator's effective set IN THE KEY'S SPACE
 * (RBAC spec §7.1). Three consequences, one test each — every denial paired
 * with the permitted twin that differs by exactly the thing under test.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { auditEvents } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
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

  it("a key stops working the moment its creator loses the space", async () => {
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

  /**
   * `api-keys:revoke` is space-level, so holding it in one space says nothing
   * about a key in another. The delegated administrator below runs space A and
   * cannot even see B; the key id is the only thing they hold, and it must not
   * be enough.
   */
  describe("revoking a key of another space", () => {
    it("answers a delegated space admin with the sibling space's own 404", async () => {
      const a = await seedSpace({ orgId: owner.orgId, visibility: "private" });
      const b = await seedSpace({ orgId: owner.orgId, visibility: "private" });
      const guest = await createTestUser();
      await addOrgMember(owner.orgId, guest.id, "guest");
      await seedSpaceMember({ spaceId: a.id, userId: guest.id, presetRole: "admin" });

      const inB = await seedApiKey({
        orgId: owner.orgId,
        spaceId: b.id,
        createdBy: owner.user.id,
        scopes: ["agents:read"],
      });
      const headers = authHeaders({ ...owner, cookie: guest.cookie }, { "X-Space-Id": a.id });

      // B does not exist for them, and neither does a key inside it.
      expect((await app.request(`/api/spaces/${b.id}`, { headers })).status).toBe(404);
      const denied = await app.request(`/api/api-keys/${inB.id}`, { method: "DELETE", headers });
      expect(denied.status).toBe(404);

      // Still live: the 404 is a refusal, not a revocation that answered oddly.
      const listed = await app.request("/api/api-keys", {
        headers: authHeaders(owner, { "X-Space-Id": b.id }),
      });
      expect(((await listed.json()) as { data: { id: string }[] }).data).toHaveLength(1);

      // Control: the same caller, the same permission, a key in the space they
      // actually administer.
      const inA = await seedApiKey({
        orgId: owner.orgId,
        spaceId: a.id,
        createdBy: owner.user.id,
        scopes: ["agents:read"],
      });
      const allowed = await app.request(`/api/api-keys/${inA.id}`, { method: "DELETE", headers });
      expect(allowed.status).toBe(204);
    });

    it("answers an API-KEY caller with 404, whatever its own space grants", async () => {
      // A key delegates authority in exactly ONE space (spec §7.1), so there is
      // no second space to authorize it against — the reach stops at the wall
      // regardless of the target space's visibility.
      const a = await seedSpace({ orgId: owner.orgId, visibility: "open" });
      const b = await seedSpace({ orgId: owner.orgId, visibility: "open" });
      const callerKey = await seedApiKey({
        orgId: owner.orgId,
        spaceId: a.id,
        createdBy: owner.user.id,
        scopes: ["api-keys:revoke"],
      });
      const inB = await seedApiKey({
        orgId: owner.orgId,
        spaceId: b.id,
        createdBy: owner.user.id,
        scopes: ["agents:read"],
      });

      const denied = await app.request(`/api/api-keys/${inB.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${callerKey.rawKey}` },
      });
      expect(denied.status).toBe(404);

      // Still live: the 404 is a refusal, not a revocation that answered oddly.
      const listed = await app.request("/api/api-keys", {
        headers: authHeaders(owner, { "X-Space-Id": b.id }),
      });
      expect(((await listed.json()) as { data: { id: string }[] }).data).toHaveLength(1);

      // Control: the same key, the same permission, a key of its OWN space.
      const inA = await seedApiKey({
        orgId: owner.orgId,
        spaceId: a.id,
        createdBy: owner.user.id,
        scopes: ["agents:read"],
      });
      const allowed = await app.request(`/api/api-keys/${inA.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${callerKey.rawKey}` },
      });
      expect(allowed.status).toBe(204);
    });

    it("files the audit row against the KEY's space, not the request's", async () => {
      const a = await seedSpace({ orgId: owner.orgId, visibility: "private" });
      const b = await seedSpace({ orgId: owner.orgId, visibility: "private" });
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: b.id,
        createdBy: owner.user.id,
        scopes: ["agents:read"],
      });

      const res = await app.request(`/api/api-keys/${key.id}`, {
        method: "DELETE",
        headers: authHeaders(owner, { "X-Space-Id": a.id }),
      });
      expect(res.status).toBe(204);

      // The route awaits the audit insert before answering, so the row is
      // already there.
      const [row] = await db
        .select({ spaceId: auditEvents.spaceId })
        .from(auditEvents)
        .where(eq(auditEvents.resourceId, key.id));
      expect(row?.spaceId).toBe(b.id);
    });

    it("lets an owner revoke across spaces — admin of every space", async () => {
      const other = await seedSpace({ orgId: owner.orgId, visibility: "private" });
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: other.id,
        createdBy: owner.user.id,
        scopes: ["agents:read"],
      });

      const res = await app.request(`/api/api-keys/${key.id}`, {
        method: "DELETE",
        headers: authHeaders(owner),
      });
      expect(res.status).toBe(204);
    });
  });
});
