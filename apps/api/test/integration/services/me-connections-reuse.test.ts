// SPDX-License-Identifier: Apache-2.0

/**
 * `reused_by_agents` on `GET /api/me/connections` (#1870): the agents that run, declaring the
 * row's integration, in a space where the row binds. An org-scope row binds in every space its
 * owner reaches — except a space with its own manual client (unless made there) and, for an
 * unshared row, a space blocking user connections (unless made there).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedPackage,
  seedPlacedPackage,
  seedSpace,
  seedSpacePackage,
  seedUnreachableSpace,
} from "../../helpers/seed.ts";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import { listMeConnections } from "../../../src/services/me-connections.ts";
import type { Actor } from "../../../src/lib/actor.ts";

const INTEGRATION = "@reuse/svc";
const AUTH = "google";

describe("listMeConnections — reused_by_agents", () => {
  let ctx: TestContext;
  let a: string;
  let b: string;
  let me: Actor;

  const declaring = (id: string): Record<string, unknown> => ({
    name: id,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.2",
    display_name: id,
    dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
  });

  async function seedAgentRunningIn(id: string, spaceId: string): Promise<void> {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: spaceId,
      draftManifest: declaring(id),
    });
    await seedSpacePackage(spaceId, id, { enabled: true });
  }

  async function seedConnection(opts: {
    from?: string;
    scopedTo?: string;
    sharedSpaceIds?: string[];
  }): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: AUTH,
        accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
        orgId: ctx.orgId,
        spaceId: opts.scopedTo ?? null,
        originSpaceId: opts.scopedTo ? null : (opts.from ?? null),
        userId: ctx.user.id,
        credentialsEncrypted: "x",
        scopesGranted: [],
        sharedSpaceIds: opts.sharedSpaceIds ?? [],
        label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  async function reuseOf(connectionId: string): Promise<number | undefined> {
    const groups = await listMeConnections(me, { kind: "user_global" });
    return groups
      .flatMap((g) => g.connections)
      .find((entry) => entry.connection_id === connectionId)?.reused_by_agents;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "reuseorg" });
    me = { type: "user", id: ctx.user.id };
    a = ctx.defaultSpaceId;
    b = (await seedSpace({ orgId: ctx.orgId, name: "B" })).id;
    const unreachable = await seedUnreachableSpace(ctx.orgId);
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      homeSpaceId: a,
      type: "integration",
      source: "local",
    });
    await seedAgentRunningIn("@reuse/in-a", a);
    await seedAgentRunningIn("@reuse/in-b", b);
    await seedAgentRunningIn("@reuse/out-of-reach", unreachable);
  });

  it("counts an org row's agents in every space its owner reaches", async () => {
    const id = await seedConnection({ from: a });
    expect(await reuseOf(id)).toBe(2);
  });

  it("counts a space-scoped row's agents in its own space only", async () => {
    const id = await seedConnection({ scopedTo: a });
    expect(await reuseOf(id)).toBe(1);
  });

  it("skips a space with its own manual client unless the row was made there", async () => {
    await db.insert(integrationOauthClients).values({
      orgId: ctx.orgId,
      spaceId: b,
      integrationId: INTEGRATION,
      authKey: AUTH,
      clientId: "byo-app",
      clientSecretEncrypted: "x",
      autoProvisioned: false,
    });
    expect(await reuseOf(await seedConnection({ from: a }))).toBe(1);
    expect(await reuseOf(await seedConnection({ from: b }))).toBe(2);
  });

  it("skips a space blocking user connections unless the row is shared or was made there", async () => {
    await seedPlacedPackage(b, INTEGRATION, { blockUserConnections: true });
    expect(await reuseOf(await seedConnection({ from: a }))).toBe(1);
    expect(await reuseOf(await seedConnection({ from: a, sharedSpaceIds: [b] }))).toBe(2);
    expect(await reuseOf(await seedConnection({ from: b }))).toBe(2);
  });

  it("counts an agent running in two spaces once", async () => {
    await seedPlacedPackage(b, "@reuse/in-a", { enabled: true });
    const id = await seedConnection({ from: a });
    expect(await reuseOf(id)).toBe(2);
  });
});
