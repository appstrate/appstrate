// SPDX-License-Identifier: Apache-2.0

/**
 * #1870 — a connection's scope is its minting client's tier. An org-scope row (system or org
 * client, or no client) serves every space of its org, except a space whose default OAuth client
 * for its auth is its own MANUAL one, unless the row was connected from there. A space-scoped row serves its
 * space only. Within that reach an actor uses their own rows and the rows shared into the space;
 * `block_user_connections` narrows their own to the shared ones and those made in the space. The
 * picker, the pins, the resolver and the credential proxy all read the same reach.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { provisionMember } from "../../../src/services/organizations.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { deleteSpace } from "../../../src/services/spaces.ts";
import {
  listAccessibleConnections,
  validatePinTargets,
} from "../../../src/services/integration-pins-service.ts";
import { resolveConnectionsForRun } from "../../../src/services/integration-connection-resolver.ts";
import { selectAccessibleConnection } from "../../../src/services/integration-connections.ts";
import type { Actor } from "../../../src/lib/actor.ts";

const AGENT = "@scopeorg/agent";
const INTEGRATION = "@scopeorg/svc";
const AUTH = "google";

const integrationManifest = localIntegrationManifest({
  name: INTEGRATION,
  serverName: "@scopeorg/svc-server",
  auths: {
    [AUTH]: {
      type: "oauth2",
      authorizationEndpoint: "https://idp.example.com/authorize",
      tokenEndpoint: "https://idp.example.com/token",
      defaultScopes: [],
    },
  },
  tools_policy: { search: {} },
});

const agentManifest = {
  name: AGENT,
  version: "1.0.0",
  type: "agent",
  schema_version: "0.2",
  display_name: "Scope agent",
  dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
  integrations_configuration: { [INTEGRATION]: { tools: ["search"], required: true } },
};

describe("org-scope connections across spaces", () => {
  let ctx: TestContext;
  let a: string;
  let b: string;
  let me: Actor;
  let colleague: Actor;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "scopeorg" });
    a = ctx.defaultSpaceId;
    b = (await seedSpace({ orgId: ctx.orgId, name: "B" })).id;
    me = { type: "user", id: ctx.user.id };
    const other = await createTestUser();
    await db.transaction((tx) => provisionMember(tx, ctx.orgId, other.id, "member"));
    colleague = { type: "user", id: other.id };
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      homeSpaceId: a,
      type: "integration",
      draftManifest: integrationManifest,
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: a }, INTEGRATION);
    await activatePackage({ orgId: ctx.orgId, spaceId: b }, INTEGRATION, { shareBy: ctx.user.id });
  });

  /** `from`: an org-scope row connected from that space; `scopedTo`: a space-scoped row. */
  async function seedConnection(opts: {
    owner: Actor;
    from?: string;
    scopedTo?: string;
    sharedSpaceIds?: string[];
    needsReconnection?: boolean;
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
        userId: opts.owner.id,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { access_token: "t" } }),
        scopesGranted: [],
        sharedSpaceIds: opts.sharedSpaceIds ?? [],
        needsReconnection: opts.needsReconnection ?? false,
        label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  async function seedSpaceClient(
    spaceId: string,
    { autoProvisioned = false, isDefault = true } = {},
  ): Promise<void> {
    await db.insert(integrationOauthClients).values({
      orgId: ctx.orgId,
      spaceId,
      integrationId: INTEGRATION,
      authKey: AUTH,
      clientId: autoProvisioned ? "dcr-client" : "byo-app",
      clientSecretEncrypted: "x",
      autoProvisioned,
      isDefault,
    });
  }

  const listed = async (spaceId: string, actor = me) =>
    (await listAccessibleConnections({ orgId: ctx.orgId, spaceId }, INTEGRATION, actor))
      .map((c) => c.id)
      .sort();

  const resolveIn = (spaceId: string, actor = me) =>
    resolveConnectionsForRun({
      agentManifest,
      packageId: AGENT,
      actor,
      scope: { orgId: ctx.orgId, spaceId },
    });

  /** The resolver's verdict in `spaceId`: the bound ids, else the error code. */
  async function verdictIn(spaceId: string, actor = me): Promise<string[] | string> {
    const { resolved, errors } = await resolveIn(spaceId, actor);
    return errors[0]?.code ?? resolved[INTEGRATION]!.map((r) => r.connectionId);
  }

  const proxySelects = async (spaceId: string, named: string | null = null) =>
    (
      await selectAccessibleConnection(INTEGRATION, integrationManifest, named, {
        spaceId,
        actor: me,
      })
    )?.id ?? null;

  const memberPin = (spaceId: string, id: string) =>
    validatePinTargets({ orgId: ctx.orgId, spaceId }, INTEGRATION, [id], {
      allowOwnedBy: ctx.user.id,
    });

  it("an org row connected from A is listed, pinnable, resolved and proxied in B", async () => {
    const id = await seedConnection({ owner: me, from: a });

    expect(await listed(b)).toEqual([id]);
    await memberPin(b, id);
    expect(await verdictIn(b)).toEqual([id]);
    expect(await proxySelects(b)).toBe(id);
  });

  it("a row of A's own OAuth client is none of those in B", async () => {
    const id = await seedConnection({ owner: me, scopedTo: a });

    expect(await listed(a)).toEqual([id]);
    expect(await listed(b)).toEqual([]);
    await expect(memberPin(b, id)).rejects.toMatchObject({ status: 404 });
    expect(await verdictIn(b)).toBe("not_connected");
    expect(await proxySelects(b)).toBeNull();
    expect(await proxySelects(b, id)).toBeNull();
  });

  it("a space defaulting to its own manual client uses no org row made elsewhere, but keeps its own", async () => {
    await seedSpaceClient(b);
    const fromA = await seedConnection({ owner: me, from: a, sharedSpaceIds: [b] });
    const fromB = await seedConnection({ owner: me, from: b });

    expect(await listed(b)).toEqual([fromB]);
    expect(await listed(a)).toEqual([fromA, fromB].sort());
    await expect(memberPin(b, fromA)).rejects.toMatchObject({ status: 404 });
    expect(await verdictIn(b)).toEqual([fromB]);
  });

  it("a space's auto-provisioned (DCR) client excludes nothing", async () => {
    await seedSpaceClient(b, { autoProvisioned: true });
    const fromA = await seedConnection({ owner: me, from: a });
    expect(await listed(b)).toEqual([fromA]);
  });

  it("a space keeping a manual client but another default uses org rows made elsewhere", async () => {
    await seedSpaceClient(b, { isDefault: false });
    const fromA = await seedConnection({ owner: me, from: a });
    expect(await listed(b)).toEqual([fromA]);
    expect(await verdictIn(b)).toEqual([fromA]);
  });

  it("a row shared into A serves other members in A only", async () => {
    const id = await seedConnection({ owner: colleague, from: a, sharedSpaceIds: [a] });

    expect(await listed(a)).toEqual([id]);
    expect(await listed(b)).toEqual([]);
    await validatePinTargets({ orgId: ctx.orgId, spaceId: a }, INTEGRATION, [id]);
    await expect(
      validatePinTargets({ orgId: ctx.orgId, spaceId: b }, INTEGRATION, [id]),
    ).rejects.toMatchObject({ status: 404 });
    // Never bound by fallback where it is usable: a colleague's row is a choice.
    expect(await verdictIn(a)).toBe("must_choose_connection");
    expect(await verdictIn(b)).toBe("not_connected");
  });

  it("several own rows: each space binds the one connected from it", async () => {
    const fromA = await seedConnection({ owner: me, from: a });
    const fromB = await seedConnection({ owner: me, from: b });
    const c = (await seedSpace({ orgId: ctx.orgId, name: "C" })).id;
    await activatePackage({ orgId: ctx.orgId, spaceId: c }, INTEGRATION, { shareBy: ctx.user.id });

    expect(await verdictIn(a)).toEqual([fromA]);
    expect(await verdictIn(b)).toEqual([fromB]);
    expect(await verdictIn(c)).toBe("must_choose_connection");
  });

  describe("block_user_connections", () => {
    beforeEach(async () => {
      await seedSpacePackage(b, INTEGRATION, { blockUserConnections: true });
    });

    it("excludes an own row not shared into the space, at every surface", async () => {
      const id = await seedConnection({ owner: me, from: a });

      expect(await listed(b)).toEqual([]);
      await expect(memberPin(b, id)).rejects.toMatchObject({ status: 404 });
      expect(await verdictIn(b)).toBe("not_connected");
      expect(await proxySelects(b)).toBeNull();
      // Control: the block is B's alone.
      expect(await verdictIn(a)).toEqual([id]);
    });

    it("keeps an own row made in the space binding there, whether space- or org-scoped", async () => {
      // Made before the block (or by a governor): the creation gate already ruled on it.
      const scoped = await seedConnection({ owner: me, scopedTo: b });
      expect(await listed(b)).toEqual([scoped]);
      expect(await verdictIn(b)).toEqual([scoped]);
      expect(await proxySelects(b)).toBe(scoped);

      const widened = await seedConnection({ owner: me, from: b });
      expect(await listed(b)).toEqual([scoped, widened].sort());
      await memberPin(b, widened);
      // Made elsewhere, it is still out of B: the origin, not the scope, exempts.
      const fromA = await seedConnection({ owner: me, from: a });
      expect(await listed(b)).not.toContain(fromA);
    });

    it("keeps an own row shared into the space usable: the share is what the block asks for", async () => {
      const id = await seedConnection({ owner: me, from: a, sharedSpaceIds: [b] });

      expect(await listed(b)).toEqual([id]);
      expect(await verdictIn(b)).toEqual([id]);
    });
  });

  it("one row, one health: needs_reconnection shows in every space it serves", async () => {
    const id = await seedConnection({ owner: me, from: a });
    await db
      .update(integrationConnections)
      .set({ needsReconnection: true })
      .where(eq(integrationConnections.id, id));

    for (const spaceId of [a, b]) {
      const { errors } = await resolveIn(spaceId);
      expect(errors.map((e) => [e.code, e.connectionId])).toEqual([["needs_reconnection", id]]);
    }
  });

  it("deleting a space drops it from every share and nulls the origin it was", async () => {
    const fromB = await seedConnection({ owner: me, from: b, sharedSpaceIds: [a, b] });
    const sharedIntoB = await seedConnection({ owner: colleague, from: a, sharedSpaceIds: [b] });

    await deleteSpace(ctx.orgId, b);

    const rows = await db
      .select({
        id: integrationConnections.id,
        originSpaceId: integrationConnections.originSpaceId,
        sharedSpaceIds: integrationConnections.sharedSpaceIds,
      })
      .from(integrationConnections)
      .where(sql`${integrationConnections.id} IN (${fromB}, ${sharedIntoB})`);
    expect(Object.fromEntries(rows.map((r) => [r.id, r]))).toEqual({
      [fromB]: { id: fromB, originSpaceId: null, sharedSpaceIds: [a] },
      [sharedIntoB]: { id: sharedIntoB, originSpaceId: a, sharedSpaceIds: [] },
    });
  });
});
