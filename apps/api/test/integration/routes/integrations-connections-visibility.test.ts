// SPDX-License-Identifier: Apache-2.0

/**
 * Connection *visibility* at the HTTP boundary — who sees which
 * `integration_connections` rows on the integration settings surface.
 *
 *   GET /api/integrations/:packageId/connections
 *   GET /api/integrations/:packageId            (`auths[].connections`, `ready`)
 *
 * Both read `listIntegrationConnections`, whose predicate is the actor's own
 * rows UNION every row opted into org-wide sharing — the same set the runtime
 * resolver picks from. Before that union the list was own-only, which made the
 * admin org-default and pin pickers unable to offer another member's shared
 * connection (they filter this list for `shared_with_org`) even though the pin
 * endpoint accepts one, and made `auths[].ready` report "not connected" for an
 * actor whose run would in fact resolve a shared connection.
 *
 * Ownership-scoped *writes* keep their own tests: metadata PATCH authz lives in
 * `integrations-authz.test.ts`, delete in `me.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/space-packages.ts";
import { integrationConnections, organizationMembers } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const INTEGRATION = "@visorg/svc";
const MCP_SERVER = "@visorg/svc-server";

interface ConnectionDTO {
  id: string;
  account_id: string;
  owner_id: string;
  owner_name?: string | null;
  identity_claims: Record<string, unknown> | null;
  shared_with_org?: boolean;
}

describe("GET /api/integrations/:packageId/connections — own ∪ org-shared", () => {
  let ctx: TestContext;
  /** A second dashboard user, plain `member` of the same org. */
  let other: Awaited<ReturnType<typeof createTestUser>>;

  function otherHeaders(): Record<string, string> {
    return {
      Cookie: other.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Space-Id": ctx.defaultSpaceId,
    };
  }

  async function seedConnection(opts: {
    userId: string;
    accountId: string;
    shared: boolean;
    needsReconnection?: boolean;
  }): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: "primary",
        accountId: opts.accountId,
        spaceId: ctx.defaultSpaceId,
        userId: opts.userId,
        endUserId: null,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret" } }),
        scopesGranted: [],
        identityClaims: { email: `${opts.accountId}@example.com`, sub: `sub-${opts.accountId}` },
        sharedWithOrg: opts.shared,
        needsReconnection: opts.needsReconnection ?? false,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  async function listAs(headers: Record<string, string>): Promise<ConnectionDTO[]> {
    const res = await app.request(`/api/integrations/${INTEGRATION}/connections`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ConnectionDTO[] };
    return body.data;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "visorg" });

    other = await createTestUser({ name: "Mike Shared" });
    await db.insert(organizationMembers).values({
      orgId: ctx.orgId,
      userId: other.id,
      role: "member",
    });

    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: INTEGRATION,
        serverName: MCP_SERVER,
        version: "1.0.0",
        auths: {
          primary: {
            type: "api_key",
            authorizedUris: ["https://api.example.com/**"],
            credentialFields: ["api_key"],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "api_key",
            }),
          },
        },
        tools_policy: { search: {} },
      }),
    });
    await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION);
  });

  it("returns another member's SHARED connection", async () => {
    const sharedId = await seedConnection({
      userId: other.id,
      accountId: "mike-shared",
      shared: true,
    });

    const ids = (await listAs(authHeaders(ctx))).map((c) => c.id);
    expect(ids).toContain(sharedId);
  });

  it("never returns another member's PRIVATE connection", async () => {
    const privateId = await seedConnection({
      userId: other.id,
      accountId: "mike-private",
      shared: false,
    });
    const ownId = await seedConnection({
      userId: ctx.user.id,
      accountId: "mine",
      shared: false,
    });

    const ids = (await listAs(authHeaders(ctx))).map((c) => c.id);
    expect(ids).toContain(ownId);
    expect(ids).not.toContain(privateId);
  });

  it("labels a shared row with its owner's display name", async () => {
    const sharedId = await seedConnection({
      userId: other.id,
      accountId: "mike-shared",
      shared: true,
    });

    const row = (await listAs(authHeaders(ctx))).find((c) => c.id === sharedId)!;
    expect(row.owner_id).toBe(other.id);
    expect(row.owner_name).toBe("Mike Shared");
  });

  it("redacts identity_claims on rows the caller does not own, keeps them on their own", async () => {
    const sharedId = await seedConnection({
      userId: other.id,
      accountId: "mike-shared",
      shared: true,
    });
    const ownId = await seedConnection({
      userId: ctx.user.id,
      accountId: "mine",
      shared: false,
    });

    const rows = await listAs(authHeaders(ctx));
    // Sharing consents to *using* the credential, not to publishing the
    // owner's OIDC claim bag (email, sub) to every member of the org.
    expect(rows.find((c) => c.id === sharedId)!.identity_claims).toBeNull();
    expect(rows.find((c) => c.id === ownId)!.identity_claims).toEqual({
      email: "mine@example.com",
      sub: "sub-mine",
    });
    // `account_id` stays: the picker DTO already exposes it, and a connection
    // you are allowed to pick has to be identifiable.
    expect(rows.find((c) => c.id === sharedId)!.account_id).toBe("mike-shared");
  });

  it("is symmetric — the sharing member still sees only their own rows plus shares", async () => {
    const adminPrivate = await seedConnection({
      userId: ctx.user.id,
      accountId: "admin-private",
      shared: false,
    });
    const mikeOwn = await seedConnection({
      userId: other.id,
      accountId: "mike-shared",
      shared: true,
    });

    const ids = (await listAs(otherHeaders())).map((c) => c.id);
    expect(ids).toContain(mikeOwn);
    // Being an org admin does not widen the *read* — only sharing does.
    expect(ids).not.toContain(adminPrivate);
  });

  it("keeps identity_claims redacted on the admin's rename echo of a shared connection", async () => {
    const sharedId = await seedConnection({
      userId: other.id,
      accountId: "mike-shared",
      shared: true,
    });

    // An org admin may rename a connection they do not own (owner OR admin on
    // the label branch). The 200 echo must not hand back what the list
    // withheld — otherwise the redaction is one PATCH away from bypassed.
    const res = await app.request(`/api/integrations/${INTEGRATION}/connections/${sharedId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Renamed by admin" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConnectionDTO & { label?: string | null };
    expect(body.label).toBe("Renamed by admin");
    expect(body.identity_claims).toBeNull();
  });

  it("still returns identity_claims when the caller renames their OWN connection", async () => {
    const ownId = await seedConnection({
      userId: ctx.user.id,
      accountId: "mine",
      shared: false,
    });

    const res = await app.request(`/api/integrations/${INTEGRATION}/connections/${ownId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "My renamed connection" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConnectionDTO;
    expect(body.identity_claims).toEqual({ email: "mine@example.com", sub: "sub-mine" });
  });

  it("reports auths[].ready for an actor who owns nothing but inherits a share", async () => {
    await seedConnection({ userId: other.id, accountId: "mike-shared", shared: true });

    const res = await app.request(`/api/integrations/${INTEGRATION}`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auths: Array<{ auth_key: string; ready: boolean; connections: ConnectionDTO[] }>;
    };
    const primary = body.auths.find((a) => a.auth_key === "primary")!;
    // The caller owns no connection at all, yet a run resolves the shared one —
    // `ready` tracks that, so the chat connect card stops asking them to
    // connect something the platform already has.
    expect(primary.ready).toBe(true);
    expect(primary.connections).toHaveLength(1);
  });

  it("does not report ready when the only shared connection needs reconnection", async () => {
    await seedConnection({
      userId: other.id,
      accountId: "mike-stale",
      shared: true,
      needsReconnection: true,
    });

    const res = await app.request(`/api/integrations/${INTEGRATION}`, {
      headers: authHeaders(ctx),
    });
    const body = (await res.json()) as { auths: Array<{ auth_key: string; ready: boolean }> };
    expect(body.auths.find((a) => a.auth_key === "primary")!.ready).toBe(false);
  });
});
