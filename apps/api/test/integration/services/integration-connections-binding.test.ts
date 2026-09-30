// SPDX-License-Identifier: Apache-2.0

/**
 * CRIT-10 regression — connection selection is BOUND to the requested
 * `integrationId` (+ pinned `auth_key` when present).
 *
 * A connection id is caller-supplied on some paths (`X-Connection-Id` on the
 * credential proxy, snapshot/override ids), so `loadAccessibleConnectionById`
 * puts BOTH `integration_id = <requested integration>` and (when pinned)
 * `auth_key = <required auth>` into the SQL WHERE and re-asserts the binding
 * before returning the row. If the fix is reverted (id-only lookup), a caller
 * could pin integration B's connection while requesting integration A and get
 * B's credentials decrypted under A's manifest + `authorized_uris` allowlist.
 *
 * Exercised through the exported `selectAccessibleConnection`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import {
  saveIntegrationConnection,
  selectAccessibleConnection,
} from "../../../src/services/integration-connections.ts";
import type { SpaceScope } from "../../../src/lib/scope.ts";
import type { Actor } from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";

const INTEG_A = "@bindorg/gmail";
const INTEG_B = "@bindorg/slack";
const manifestOf = (name: string) =>
  ({ name, auths: { oauth: { type: "api_key" } } }) as unknown as IntegrationManifest;

describe("selectAccessibleConnection — integrationId + authKey binding (CRIT-10)", () => {
  let ctx: TestContext;
  let scope: SpaceScope;
  let actor: Actor;
  let connAId: string;
  let connBId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bindorg" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    actor = { type: "user", id: ctx.user.id };

    // Two DIFFERENT integrations in the SAME space, both connected by
    // the SAME actor — the exact setup where an id-only lookup would leak.
    await seedPackage({ id: INTEG_A, orgId: ctx.orgId, type: "integration", source: "local" });
    await seedPackage({ id: INTEG_B, orgId: ctx.orgId, type: "integration", source: "local" });

    const connA = await saveIntegrationConnection(scope, {
      packageId: INTEG_A,
      authKey: "oauth",
      accountId: "alice@example.com",
      credentials: { access_token: "token-for-integration-a" },
      actor,
    });
    connAId = connA.id;

    const connB = await saveIntegrationConnection(scope, {
      packageId: INTEG_B,
      authKey: "oauth",
      accountId: "alice@example.com",
      credentials: { access_token: "token-for-integration-b" },
      actor,
    });
    connBId = connB.id;
  });

  it("never resolves integration B's connection id under integration A", async () => {
    // Ask for integration A's connection but pass B's connection id — an
    // id-only WHERE would return B's row and inject B's credentials under A's
    // manifest. This MUST NOT resolve.
    const leaked = await selectAccessibleConnection(INTEG_A, manifestOf(INTEG_A), connBId, {
      spaceId: ctx.defaultSpaceId,
      actor,
    });
    expect(leaked).toBeNull();

    // Symmetric direction for completeness.
    const leakedReverse = await selectAccessibleConnection(INTEG_B, manifestOf(INTEG_B), connAId, {
      spaceId: ctx.defaultSpaceId,
      actor,
    });
    expect(leakedReverse).toBeNull();
  });

  it("resolves the connection when the id belongs to the requested integration (happy path)", async () => {
    const resolved = await selectAccessibleConnection(INTEG_B, manifestOf(INTEG_B), connBId, {
      spaceId: ctx.defaultSpaceId,
      actor,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(connBId);
    expect(resolved!.authKey).toBe("oauth");
  });
});
