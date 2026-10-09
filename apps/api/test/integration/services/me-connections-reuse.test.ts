// SPDX-License-Identifier: Apache-2.0

/**
 * `reused_by_agents` on `GET /api/me/connections`: the distinct agents declaring the row's
 * integration, run in every space where its owner runs agents and may use it, and in its share
 * targets — within the bound space only for a credential bound to one.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPlacedPackage, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import { listMeConnections } from "../../../src/services/me-connections.ts";
import type { MeConnectionAuthority } from "../../../src/services/connection-reach.ts";
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

  async function reuseOf(
    connectionId: string,
    authority: MeConnectionAuthority = { kind: "user_global" },
  ): Promise<number | undefined> {
    const groups = await listMeConnections(me, authority);
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
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      homeSpaceId: a,
      type: "integration",
      source: "local",
    });
    await seedAgentRunningIn("@reuse/in-a", a);
    await seedAgentRunningIn("@reuse/in-b", b);
  });

  async function seedOwnManualDefaultClient(spaceId: string): Promise<void> {
    await db.insert(integrationOauthClients).values({
      orgId: ctx.orgId,
      spaceId,
      integrationId: INTEGRATION,
      authKey: AUTH,
      clientId: `manual-${spaceId}`,
      clientSecretEncrypted: "x",
      isDefault: true,
      autoProvisioned: false,
    });
  }

  it("counts an org row's agents in every space its owner runs it in, shared or not", async () => {
    expect(await reuseOf(await seedConnection({ from: a }))).toBe(2);
    expect(await reuseOf(await seedConnection({ from: a, sharedSpaceIds: [b] }))).toBe(2);
  });

  it("counts an org row made in A whose only agent runs in B", async () => {
    await seedSpacePackage(a, "@reuse/in-a", { enabled: false });
    expect(await reuseOf(await seedConnection({ from: a }))).toBe(1);
  });

  it("does not count B when B blocks user connections", async () => {
    await seedPlacedPackage(b, INTEGRATION, { blockUserConnections: true });
    expect(await reuseOf(await seedConnection({ from: a }))).toBe(1);
  });

  it("does not count B when B defaults to its own manual client", async () => {
    await seedOwnManualDefaultClient(b);
    expect(await reuseOf(await seedConnection({ from: a }))).toBe(1);
  });

  it("still counts B when the row is shared into it", async () => {
    await seedOwnManualDefaultClient(b);
    expect(await reuseOf(await seedConnection({ from: a, sharedSpaceIds: [b] }))).toBe(2);
  });

  it("counts a space-scoped row's agents in its own space only", async () => {
    const id = await seedConnection({ scopedTo: a });
    expect(await reuseOf(id)).toBe(1);
  });

  it("counts an agent running in two of the row's spaces once", async () => {
    await seedPlacedPackage(b, "@reuse/in-a", { enabled: true });
    const id = await seedConnection({ from: a, sharedSpaceIds: [b] });
    expect(await reuseOf(id)).toBe(2);
  });

  it("counts the bound space only for a credential bound to one", async () => {
    const id = await seedConnection({ from: b, sharedSpaceIds: [a] });
    expect(await reuseOf(id)).toBe(2);
    expect(await reuseOf(id, { kind: "bound", orgId: ctx.orgId, spaceId: a })).toBe(1);
  });
});
