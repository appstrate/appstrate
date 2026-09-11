// SPDX-License-Identifier: Apache-2.0

/**
 * `attachConnectOffers` against real rows (#1207) — the `block_user_connections`
 * gate, the one input to the mint that cannot be faked through the manifest
 * memo: `isUserConnectionCreationBlocked` reads `space_packages`.
 *
 * The pure decision matrix lives in `test/unit/services/preflight-connect-offer.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/space-packages.ts";
import { spacePackages } from "@appstrate/db/schema";
import { and, eq } from "drizzle-orm";
import { attachConnectOffers } from "../../../src/services/connect/preflight-connect-offer.ts";
import { readConnectToken } from "../../../src/services/connect/connect-session.ts";
import type { IntegrationManifestCache } from "../../../src/services/integration-service.ts";
import type { ResolutionFieldError } from "../../../src/lib/errors.ts";
import type { Actor } from "../../../src/lib/actor.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

const INTEGRATION = "@offers/blocked-svc";
const ACTOR: Actor = { type: "user", id: "user-1" };

function oauthManifest(): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    source: { kind: "none" },
    auths: {
      primary: {
        type: "oauth2",
        delivery: { http: { in: "header", name: "Authorization", value: "Bearer x" } },
      },
    },
  } as unknown as IntegrationManifest;
}

/** Pre-seeded memo — `fetchIntegrationManifest` returns the hit without a SELECT. */
function manifestCache(): IntegrationManifestCache {
  const cache: IntegrationManifestCache = new Map();
  cache.set(INTEGRATION, Promise.resolve({ ok: true, manifest: oauthManifest() }));
  return cache;
}

function notConnected(): ResolutionFieldError {
  return {
    field: `integrations.${INTEGRATION}`,
    code: "not_connected",
    title: "Integration Not Connected",
    message: "not connected",
    auth_key: "primary",
  };
}

describe("attachConnectOffers — block_user_connections", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "offers" });
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: oauthManifest() as unknown as Record<string, unknown>,
    });
    await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION);
    await db
      .update(spacePackages)
      .set({ blockUserConnections: true })
      .where(
        and(
          eq(spacePackages.spaceId, ctx.defaultSpaceId),
          eq(spacePackages.packageId, INTEGRATION),
        ),
      );
  });

  it("refuses to mint for an actor who may only connect", async () => {
    const errors = [notConnected()];
    expect(
      await attachConnectOffers({
        errors,
        scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        actor: ACTOR,
        policy: { canConnect: true, canConfigure: false },
        manifestCache: manifestCache(),
      }),
    ).toEqual(errors);
  });

  it("mints for an actor holding integrations:configure — the admin carve-out", async () => {
    // Same carve-out as `assertConnectionCreationAllowed`: an admin may create
    // the shared connection the block exists to force everyone onto.
    const [item] = await attachConnectOffers({
      errors: [notConnected()],
      scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      actor: ACTOR,
      policy: { canConnect: true, canConfigure: true },
      manifestCache: manifestCache(),
    });
    expect(item!.connect_url).toStartWith("http");
    const token = new URL(item!.connect_url!).searchParams.get("token");
    expect(readConnectToken(token!)).toMatchObject({
      org_id: ctx.orgId,
      space_id: ctx.defaultSpaceId,
      package_id: INTEGRATION,
    });
  });
});
