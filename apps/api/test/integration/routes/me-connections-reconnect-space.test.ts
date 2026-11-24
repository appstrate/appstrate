// SPDX-License-Identifier: Apache-2.0

/**
 * `reconnect_space_id` on the account surface, which acts from no space: a renewal is started in a
 * space where its owner holds `integrations:connect` and the row serves, its own or origin space
 * first. Without one the list withholds `reconnect`, rather than offer a kickoff that answers 403.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpace, seedSpaceMember } from "../../helpers/seed.ts";

const app = getTestApp();

let owner: TestContext;

beforeEach(async () => {
  await truncateAll();
  owner = await createTestContext();
  await seedPackage({ id: "@reorg/mail", orgId: owner.orgId, type: "integration" });
});

async function seedConnection(
  userId: string,
  where: { spaceId: string | null; originSpaceId: string | null },
): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: "@reorg/mail",
      authKey: "api",
      accountId: "alice@example.test",
      orgId: owner.orgId,
      ...where,
      userId,
      credentialsEncrypted: "x",
      scopesGranted: [],
      label: "Mail",
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

async function listed(ctx: TestContext, connectionId: string) {
  const res = await app.request("/api/me/connections", { headers: { Cookie: ctx.cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: Array<{
      connections: Array<{
        connection_id: string;
        allowed_actions: string[];
        reconnect_space_id: string | null;
      }>;
    }>;
  };
  return body.data.flatMap((g) => g.connections).find((c) => c.connection_id === connectionId)!;
}

describe("GET /api/me/connections: where a renewal starts", () => {
  it("renews a row serving the whole org in the space it was made in", async () => {
    const gestion = await seedSpace({ orgId: owner.orgId, name: "Gestion" });
    const id = await seedConnection(owner.user.id, { spaceId: null, originSpaceId: gestion.id });
    expect(await listed(owner, id)).toMatchObject({
      allowed_actions: expect.arrayContaining(["reconnect"]),
      reconnect_space_id: gestion.id,
    });
  });

  it("withholds reconnect where its owner may connect in no space the row serves", async () => {
    const viewer = await memberContext(owner, "member", "viewer");
    const id = await seedConnection(viewer.user.id, {
      spaceId: owner.defaultSpaceId,
      originSpaceId: null,
    });
    const row = await listed(viewer, id);
    expect(row.allowed_actions).not.toContain("reconnect");
    expect(row.reconnect_space_id).toBeNull();
  });

  it("starts it in another space of the org when the origin no longer admits a connect", async () => {
    const viewer = await memberContext(owner, "member", "viewer");
    const team = await seedSpace({ orgId: owner.orgId, name: "Team", visibility: "closed" });
    await seedSpaceMember({ spaceId: team.id, userId: viewer.user.id, presetRole: "runner" });
    const id = await seedConnection(viewer.user.id, {
      spaceId: null,
      originSpaceId: owner.defaultSpaceId,
    });
    expect((await listed(viewer, id)).reconnect_space_id).toBe(team.id);
  });
});
