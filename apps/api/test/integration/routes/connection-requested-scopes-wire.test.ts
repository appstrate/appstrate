// SPDX-License-Identifier: Apache-2.0

/**
 * `requested_scopes` on the connection wire objects: the owner's step-up demand, shown to the
 * owner on the account list and the integration's connection list, never to a member the
 * connection is shared with.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { integrationConnections } from "@appstrate/db/schema";
import type { IntegrationConnection, MeConnectionSourceGroup } from "@appstrate/shared-types";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, memberContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpacePackage } from "../../helpers/seed.ts";
import { seedShares } from "../../helpers/connection-shares.ts";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";

const INTEGRATION = "@myorg/probe";
const app = getTestApp();

describe("requested_scopes on the connection wire", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("reaches the owner on both lists and no one else", async () => {
    const owner = await createTestContext({ orgSlug: "myorg" });
    await seedPackage({
      id: INTEGRATION,
      orgId: owner.orgId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: INTEGRATION,
        auths: { google: { type: "api_key" } },
      }),
      homeSpaceId: owner.defaultSpaceId,
    });
    await seedSpacePackage(owner.defaultSpaceId, INTEGRATION);
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: "google",
        accountId: "member@example.test",
        orgId: owner.orgId,
        spaceId: owner.defaultSpaceId,
        userId: owner.user.id,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
        requestedScopes: ["mail.send"],
        label: "Work",
      })
      .returning({ id: integrationConnections.id });
    await seedShares(row!.id, [owner.defaultSpaceId]);
    const colleague = await memberContext(owner, "member");

    const listed = async (ctx: typeof owner) =>
      (
        (await (
          await app.request(`/api/integrations/${INTEGRATION}/connections`, {
            headers: authHeaders(ctx),
          })
        ).json()) as { data: IntegrationConnection[] }
      ).data.find((c) => c.id === row!.id);

    expect((await listed(owner))?.requested_scopes).toEqual(["mail.send"]);
    const seen = await listed(colleague);
    expect(seen).toBeDefined();
    expect(seen).not.toHaveProperty("requested_scopes");

    const me = (await (
      await app.request("/api/me/connections", { headers: authHeaders(owner) })
    ).json()) as { data: MeConnectionSourceGroup[] };
    expect(me.data.flatMap((g) => g.connections).map((c) => c.requested_scopes)).toEqual([
      ["mail.send"],
    ]);
  });
});
