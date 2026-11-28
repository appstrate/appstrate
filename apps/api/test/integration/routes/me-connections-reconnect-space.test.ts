// SPDX-License-Identifier: Apache-2.0

/**
 * `reconnect_space_id` on the account surface, which acts from no space: a renewal is started in a
 * space where its owner holds `integrations:connect` and the row serves, its own or origin space
 * first. Without one the list withholds `reconnect`, rather than offer a kickoff that answers 403.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@appstrate/db/client";
import type { MeConnectionSourceGroup } from "@appstrate/shared-types";
import { integrationConnections } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";
import {
  seedApiKey,
  seedEndUser,
  seedPackage,
  seedPackageShare,
  seedPublishedVersion,
  seedSpace,
  seedSpaceMember,
} from "../../helpers/seed.ts";

const app = getTestApp();

const packageId = "@reorg/mail";
let owner: TestContext;

beforeEach(async () => {
  await truncateAll();
  owner = await createTestContext();
  await seedPackage({
    id: packageId,
    orgId: owner.orgId,
    type: "integration",
    draftManifest: localIntegrationManifest({
      name: packageId,
      auths: { api: { type: "api_key" } },
    }),
  });
});

async function seedConnection(
  actor: { userId: string } | { endUserId: string },
  where: { spaceId: string | null; originSpaceId: string | null },
  flag?: { cause: "refresh_token_revoked"; at: Date },
  label = "Mail",
): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: packageId,
      authKey: "api",
      accountId: "alice@example.test",
      orgId: owner.orgId,
      ...where,
      ...actor,
      credentialsEncrypted: "x",
      scopesGranted: [],
      label,
      ...(flag
        ? {
            needsReconnection: true,
            needsReconnectionCause: flag.cause,
            needsReconnectionAt: flag.at,
          }
        : {}),
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

async function listed(headers: Record<string, string>, connectionId: string) {
  const res = await app.request("/api/me/connections", { headers });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: MeConnectionSourceGroup[] };
  return body.data.flatMap((g) => g.connections).find((c) => c.connection_id === connectionId)!;
}

async function expectRenewal(
  headers: Record<string, string>,
  connectionId: string,
  expectedSpace: string,
) {
  const row = await listed(headers, connectionId);
  expect(row.allowed_actions).toContain("reconnect");
  expect(row.reconnect_space_id).toBe(expectedSpace);
  const start = await app.request(`/api/integrations/${packageId}/auths/api/connect/session`, {
    method: "POST",
    headers: {
      ...headers,
      "X-Space-Id": row.reconnect_space_id!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ connection_id: connectionId }),
  });
  expect(start.status).toBe(200);
}

describe("GET /api/me/connections: where a renewal starts", () => {
  it("renews a row serving the whole org in the space it was made in", async () => {
    const gestion = await seedSpace({ orgId: owner.orgId, name: "Gestion" });
    const id = await seedConnection(
      { userId: owner.user.id },
      { spaceId: null, originSpaceId: gestion.id },
    );
    await seedPackageShare(gestion.id, packageId);
    await expectRenewal(authHeaders(owner), id, gestion.id);
  });

  it("withholds reconnect where its owner may connect in no space the row serves", async () => {
    const viewer = await memberContext(owner, "member", "viewer");
    const id = await seedConnection(
      { userId: viewer.user.id },
      {
        spaceId: owner.defaultSpaceId,
        originSpaceId: null,
      },
    );
    const row = await listed(authHeaders(viewer), id);
    expect(row.allowed_actions).not.toContain("reconnect");
    expect(row.reconnect_space_id).toBeNull();
  });

  it("starts it in another space of the org when the origin no longer admits a connect", async () => {
    const viewer = await memberContext(owner, "member", "viewer");
    const team = await seedSpace({ orgId: owner.orgId, name: "Team", visibility: "closed" });
    await seedSpaceMember({ spaceId: team.id, userId: viewer.user.id, presetRole: "runner" });
    const id = await seedConnection(
      { userId: viewer.user.id },
      {
        spaceId: null,
        originSpaceId: owner.defaultSpaceId,
      },
    );
    // The team grants connect, but the integration is not placed there yet.
    const before = await listed(authHeaders(viewer), id);
    expect(before.reconnect_space_id).toBeNull();
    expect(before.allowed_actions).not.toContain("reconnect");
    await seedPackageShare(team.id, packageId);
    await expectRenewal(authHeaders(viewer), id, team.id);
  });

  it("falls back from an unplaced origin to the integration's home", async () => {
    const origin = await seedSpace({ orgId: owner.orgId, name: "Previous origin" });
    const id = await seedConnection(
      { userId: owner.user.id },
      { spaceId: null, originSpaceId: origin.id },
    );
    await expectRenewal(authHeaders(owner), id, owner.defaultSpaceId);
  });

  it("serves the recorded death cause and its date, or null/null for a live row", async () => {
    const where = { spaceId: owner.defaultSpaceId, originSpaceId: null };
    const flaggedId = await seedConnection({ userId: owner.user.id }, where, {
      cause: "refresh_token_revoked",
      at: new Date("2026-03-01T10:00:00.000Z"),
    });
    const liveId = await seedConnection({ userId: owner.user.id }, where, undefined, "Mail live");
    expect(await listed(authHeaders(owner), flaggedId)).toMatchObject({
      needs_reconnection: true,
      needs_reconnection_cause: "refresh_token_revoked",
      needs_reconnection_at: "2026-03-01T10:00:00.000Z",
    });
    expect(await listed(authHeaders(owner), liveId)).toMatchObject({
      needs_reconnection: false,
      needs_reconnection_cause: null,
      needs_reconnection_at: null,
    });
  });

  it("withholds renewal when the published integration no longer declares the row's auth", async () => {
    const id = await seedConnection(
      { userId: owner.user.id },
      { spaceId: owner.defaultSpaceId, originSpaceId: null },
    );
    await seedPublishedVersion(packageId, "2.0.0", {
      manifest: localIntegrationManifest({
        name: packageId,
        version: "2.0.0",
        auths: { other: { type: "api_key" } },
      }),
    });
    const row = await listed(authHeaders(owner), id);
    expect(row.allowed_actions).not.toContain("reconnect");
    expect(row.reconnect_space_id).toBeNull();
  });

  it("uses the pinned space and the key issuer's effective grants for an end user", async () => {
    const spaceId = owner.defaultSpaceId;
    const endUser = await seedEndUser({ orgId: owner.orgId, spaceId });
    const id = await seedConnection({ endUserId: endUser.id }, { spaceId, originSpaceId: null });
    async function endUserHeaders(issuer: TestContext) {
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId,
        createdBy: issuer.user.id,
        scopes: ["integrations:read", "integrations:connect"],
      });
      return { Authorization: `Bearer ${key.rawKey}`, "Appstrate-User": endUser.id };
    }
    await expectRenewal(await endUserHeaders(owner), id, spaceId);
    const viewer = await memberContext(owner, "member", "viewer");
    const row = await listed(await endUserHeaders(viewer), id);
    expect(row.allowed_actions).not.toContain("reconnect");
    expect(row.reconnect_space_id).toBeNull();
  });
});
