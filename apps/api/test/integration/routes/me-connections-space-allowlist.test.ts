// SPDX-License-Identifier: Apache-2.0

/**
 * Its owner's connections under a credential bound to a SET of spaces (`AuthResolution.spaceIds`,
 * here the chat's MCP loopback bearer): `connectionPrincipal` binds it to its spaces, so it shares
 * into and withdraws from none outside them, never shares into every space, reaches no row
 * outside them, and writes none serving the whole organization. The caller is the org owner, so
 * its permissions alone would serve every space.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@appstrate/db/client";
import { integrationConnectionShares, integrationConnections } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestOrg, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpace } from "../../helpers/seed.ts";
import { loopbackHeaders } from "../../helpers/loopback.ts";
import { orgPermissions, presetPermissions } from "../../../src/lib/permissions.ts";

const app = getTestApp();

let owner: TestContext;
let gestion: { id: string };

beforeEach(async () => {
  await truncateAll();
  owner = await createTestContext();
  gestion = await seedSpace({ orgId: owner.orgId, name: "Gestion", visibility: "closed" });
  await seedPackage({ id: "@chatorg/gmail", orgId: owner.orgId, type: "integration" });
});

/** The org owner's bearer allowlisting the default space alone. */
const ownerBearer = () =>
  loopbackHeaders(owner, owner.orgId, {
    orgRole: "owner",
    permissions: [...orgPermissions("owner"), ...presetPermissions("admin"), "mcp:read"],
    spaceIds: [owner.defaultSpaceId],
  });

/** One of the owner's connections; `spaceId` null: it serves the whole organization. */
async function seedConnection(spaceId: string | null, label: string): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: "@chatorg/gmail",
      authKey: "google",
      accountId: `acct-${label}`,
      orgId: owner.orgId,
      spaceId,
      originSpaceId: spaceId === null ? owner.defaultSpaceId : null,
      userId: owner.user.id,
      credentialsEncrypted: "x",
      scopesGranted: [],
      label,
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

const sharedSpaces = async () =>
  (
    await db
      .select({ spaceId: integrationConnectionShares.spaceId })
      .from(integrationConnectionShares)
  ).map((row) => row.spaceId);

describe("its owner's connections under a space allowlist", () => {
  it("shares a connection into no space outside its allowlist, nor into every space", async () => {
    const id = await seedConnection(null, "Work");
    const headers = ownerBearer();
    const share = (spaceId: string) =>
      app.request(`/api/me/connections/${id}/shares/${spaceId}`, { method: "PUT", headers });

    // Org owner, so `integrations:connect` in Gestion too, yet the bearer does not reach it.
    expect((await share(gestion.id)).status).toBe(403);
    expect((await share(owner.defaultSpaceId)).status).toBe(204);
    const all = await app.request(`/api/me/connections/${id}/shares`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ share_all_spaces: true }),
    });
    expect(all.status).toBe(403);
    expect(await sharedSpaces()).toEqual([owner.defaultSpaceId]);
  });

  it("withdraws a connection from no space outside its allowlist, though it owns the connection", async () => {
    const id = await seedConnection(null, "Work");
    await db.insert(integrationConnectionShares).values([
      { connectionId: id, spaceId: owner.defaultSpaceId, orgId: owner.orgId },
      { connectionId: id, spaceId: gestion.id, orgId: owner.orgId },
    ]);
    const unshare = (spaceId: string) =>
      app.request(`/api/me/connections/${id}/shares/${spaceId}`, {
        method: "DELETE",
        headers: ownerBearer(),
      });

    expect((await unshare(gestion.id)).status).toBe(403);
    expect((await unshare(owner.defaultSpaceId)).status).toBe(204);
    expect(await sharedSpaces()).toEqual([gestion.id]);
  });

  it("reaches no connection outside its allowlist, nor writes one serving the whole org", async () => {
    const outside = await seedConnection(gestion.id, "Gestion");
    const inside = await seedConnection(owner.defaultSpaceId, "Default");
    const orgWide = await seedConnection(null, "Org");
    const headers = { ...ownerBearer(), "Content-Type": "application/json" };
    const call = (path: string, method = "GET", body?: unknown) =>
      app.request(path, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    const listed = (await (await call("/api/me/connections")).json()) as {
      data: Array<{
        connections: Array<{
          connection_id: string;
          allowed_actions: string[];
          reconnect_space_id: string | null;
        }>;
      }>;
    };
    const actions = Object.fromEntries(
      listed.data.flatMap((group) =>
        group.connections.map((row) => [row.connection_id, row.allowed_actions] as const),
      ),
    );
    expect(actions).toEqual({
      [inside]: ["rename", "reconnect", "share"],
      [orgWide]: ["share"],
    });
    const renewIn = Object.fromEntries(
      listed.data.flatMap((group) =>
        group.connections.map((row) => [row.connection_id, row.reconnect_space_id] as const),
      ),
    );
    expect(renewIn).toEqual({ [inside]: owner.defaultSpaceId, [orgWide]: null });

    // Outside the allowlist: not there, whatever the action.
    expect((await call(`/api/me/connections/${outside}`, "PATCH", { label: "x" })).status).toBe(
      404,
    );
    expect((await call(`/api/me/connections/${outside}/calls`)).status).toBe(404);
    expect(
      ((await (await call(`/api/me/connections/${outside}/handoff`)).json()) as { data: [] }).data,
    ).toEqual([]);
    expect((await call(`/api/me/connections/${outside}`, "DELETE")).status).toBe(204);
    // A row serving the whole org serves spaces outside the allowlist too: listed, not written.
    expect((await call(`/api/me/connections/${orgWide}`, "PATCH", { label: "y" })).status).toBe(
      403,
    );
    expect((await call(`/api/me/connections/${orgWide}`, "DELETE")).status).toBe(403);
    // Inside it, the owner's own row is renamed.
    expect(
      (await call(`/api/me/connections/${inside}`, "PATCH", { label: "Renamed" })).status,
    ).toBe(200);

    const rows = await db
      .select({ id: integrationConnections.id, label: integrationConnections.label })
      .from(integrationConnections);
    expect(Object.fromEntries(rows.map((row) => [row.id, row.label]))).toEqual({
      [outside]: "Gestion",
      [inside]: "Renamed",
      [orgWide]: "Org",
    });
  });
});

describe("an unlimited conversation's bearer acts within its organization, as the member does", () => {
  const bearer = (restricted: boolean) =>
    loopbackHeaders(owner, owner.orgId, {
      orgRole: "owner",
      permissions: [...orgPermissions("owner"), ...presetPermissions("admin"), "mcp:read"],
      spaceIds: [owner.defaultSpaceId],
      restricted,
    });

  /** The owner's connection of a second organization they also own. */
  async function seedOtherOrgConnection(): Promise<string> {
    const { org, defaultSpaceId } = await createTestOrg(owner.user.id);
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: "@chatorg/gmail",
        authKey: "google",
        accountId: "acct-other",
        orgId: org.id,
        spaceId: null,
        originSpaceId: defaultSpaceId,
        userId: owner.user.id,
        credentialsEncrypted: "x",
        scopesGranted: [],
        label: "Other org",
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  const call = (headers: Record<string, string>, path: string, method = "GET", body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const listedIds = async (headers: Record<string, string>) => {
    const listed = (await (await call(headers, "/api/me/connections")).json()) as {
      data: Array<{ connections: Array<{ connection_id: string }> }>;
    };
    return listed.data.flatMap((group) => group.connections.map((row) => row.connection_id));
  };

  it("lists and renames its org's org-scope connection, and sees nothing of another org", async () => {
    const mine = await seedConnection(null, "Org");
    const other = await seedOtherOrgConnection();
    const headers = bearer(false);

    expect(await listedIds(headers)).toEqual([mine]);
    expect(
      (await call(headers, `/api/me/connections/${mine}`, "PATCH", { label: "Renamed" })).status,
    ).toBe(200);
    // A delete is idempotent (204), but the row of the other org stays.
    expect((await call(headers, `/api/me/connections/${other}`, "DELETE")).status).toBe(204);
    expect(
      (await call(headers, `/api/me/connections/${other}`, "PATCH", { label: "x" })).status,
    ).toBe(404);
    expect((await call(headers, `/api/me/connections/${mine}`, "DELETE")).status).toBe(204);
    const left = await db.select({ id: integrationConnections.id }).from(integrationConnections);
    expect(left.map((row) => row.id)).toEqual([other]);
  });

  it("a limited conversation's bearer sees nothing of another org either, and deletes no org-scope row", async () => {
    const mine = await seedConnection(null, "Org");
    const other = await seedOtherOrgConnection();
    const headers = bearer(true);

    expect(await listedIds(headers)).toEqual([mine]);
    // A delete is idempotent (204), but the row of the other org stays.
    expect((await call(headers, `/api/me/connections/${other}`, "DELETE")).status).toBe(204);
    expect((await call(headers, `/api/me/connections/${mine}`, "DELETE")).status).toBe(403);
    const left = await db.select({ id: integrationConnections.id }).from(integrationConnections);
    expect(left.map((row) => row.id).sort()).toEqual([mine, other].sort());
  });
});
