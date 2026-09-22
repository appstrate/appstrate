// SPDX-License-Identifier: Apache-2.0

/**
 * Admin integration surface — HTTP boundary tests.
 *
 * Three endpoints drive the integration detail page's admin section:
 *
 *   GET    /api/agents/:scope/:name/connection-readiness
 *          Bulk per-agent verdict (resolver cascade + candidate list +
 *          pin/blocked state per declared integration). The SPA renders each
 *          integration's resolution verbatim — no client-side re-implementation
 *          of the cascade.
 *
 *   PUT    /api/integrations/:packageId/pins/:agentPackageId
 *   DELETE /api/integrations/:packageId/pins/:agentPackageId
 *          Admin org-level pins (sharedWithOrg-required, layer 1 of the
 *          resolver cascade). Gated on `integrations:configure`.
 *
 *   GET    /api/integrations/:packageId/pins
 *          List all admin pins for an integration.
 *
 *   GET    /api/integrations/:packageId/consuming-agents
 *          Drives the "pin a new agent" picker.
 *
 * Service-layer behaviour (validation rules, sharedWithOrg enforcement,
 * cascade resolution semantics) is covered by
 * `services/integration-pins-service.test.ts` and
 * `unit/services/integration-connection-resolver.test.ts`. This file pins
 * the HTTP boundary: auth, admin-only gate, response shape.
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
import { seedAgent, seedPackage } from "../../helpers/seed.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { integrationConnections, organizationMembers } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";

const app = getTestApp();

const AGENT = "@adminorg/agent-a";
const SECOND_AGENT = "@adminorg/agent-b";
const INTEGRATION = "@adminorg/svc";
const MCP_SERVER = "@adminorg/svc-server";

function buildAgentManifest(name: string): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.2",
    display_name: `Admin Test Agent ${name}`,
    dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
    integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
  };
}

function buildIntegrationManifest() {
  return localIntegrationManifest({
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
  });
}

describe("/api/integrations/:packageId admin surface", () => {
  let ctx: TestContext;

  async function seedSharedConnection(): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: "primary",
        accountId: `acct-shared`,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        endUserId: null,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret" } }),
        scopesGranted: [],
        sharedWithOrg: true,
        label: `Partagée ${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  async function seedPrivateConnectionFor(userId: string): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: "primary",
        accountId: `acct-private-${userId.slice(0, 6)}`,
        spaceId: ctx.defaultSpaceId,
        userId,
        endUserId: null,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret" } }),
        scopesGranted: [],
        sharedWithOrg: false,
        label: `Perso ${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "adminorg" });

    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest(AGENT),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);

    await seedPackage({
      id: INTEGRATION,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: buildIntegrationManifest(),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION);
  });

  // ─── GET /api/agents/:scope/:name/connection-readiness ─────────────
  // The per-integration verdict is now served in bulk per agent; the resolution
  // for one integration is read from `integrations[].resolution`.

  interface AgentResolutionDTO {
    status: string;
    resolved_connection_ids: string[];
    resolved_missing_scopes: string[];
    admin_pinned_connection_ids: string[];
    member_pinned_connection_ids: string[];
    org_default_connection_ids: string[];
    org_default_enforced: boolean;
    can_add_connection: boolean;
    candidates: Array<{ id: string; is_own: boolean; missing_scopes: string[] }>;
  }

  /** GET the bulk readiness and return one integration's resolution DTO. */
  async function getResolution(
    agentId: string,
    integrationId: string,
  ): Promise<AgentResolutionDTO> {
    const res = await app.request(`/api/agents/${agentId}/connection-readiness`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      integrations: Array<{ integration_id: string; resolution: AgentResolutionDTO }>;
    };
    const entry = body.integrations.find((i) => i.integration_id === integrationId);
    if (!entry) throw new Error(`integration ${integrationId} not in readiness`);
    return entry.resolution;
  }

  describe("GET /api/agents/:scope/:name/connection-readiness — per-integration resolution", () => {
    it("returns the full resolution verdict shape for a declared integration", async () => {
      const connId = await seedPrivateConnectionFor(ctx.user.id);

      const body = await getResolution(AGENT, INTEGRATION);

      // Wire-shape contract — all fields present, snake_case.
      expect(body).toHaveProperty("status");
      expect(body).toHaveProperty("resolved_connection_ids");
      expect(body).toHaveProperty("resolved_missing_scopes");
      expect(body).toHaveProperty("admin_pinned_connection_ids");
      expect(body).toHaveProperty("member_pinned_connection_ids");
      expect(body).toHaveProperty("org_default_connection_ids");
      expect(body).toHaveProperty("org_default_enforced");
      expect(body).toHaveProperty("can_add_connection");
      expect(Array.isArray(body.candidates)).toBe(true);

      // With one private connection on the actor and no pin/default:
      // resolver picks it auto → status="auto", resolved=owned connection.
      expect(body.status).toBe("auto");
      expect(body.resolved_connection_ids).toEqual([connId]);
    });

    it("returns 'none' status when actor has no accessible connection", async () => {
      // No connection seeded — picker should surface "none".
      const body = await getResolution(AGENT, INTEGRATION);
      expect(body.status).toBe("none");
      expect(body.candidates).toEqual([]);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(`/api/agents/${AGENT}/connection-readiness`);
      expect(res.status).toBe(401);
    });

    // Regression (#576 follow-up): an INERT integration entry (declared with an
    // auth_key but no tools/scopes) is still listed in the bulk readiness with a
    // resolution (includeInert), and that resolution must honour the member pin —
    // otherwise a PUT /me/integration-pins succeeds (200) but the verdict stays
    // "must_choose" and the picker can never reflect the selection.
    it("honours the member pin on an INERT integration (no tools/scopes)", async () => {
      const INERT_AGENT = "@adminorg/agent-inert";
      await seedAgent({
        id: INERT_AGENT,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: INERT_AGENT,
          version: "1.0.0",
          type: "agent",
          schema_version: "0.2",
          display_name: "Inert Test Agent",
          dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
          integrations_configuration: { [INTEGRATION]: { auth_key: "primary" } },
        },
      });
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INERT_AGENT);

      // Two accessible connections → ambiguous → must_choose until pinned.
      const connA = await seedPrivateConnectionFor(ctx.user.id);
      const connB = await seedSharedConnection();

      const before = await getResolution(INERT_AGENT, INTEGRATION);
      expect(before.status).toBe("must_choose");
      expect(before.resolved_connection_ids).toEqual([]);

      // Member pins connection B via the same endpoint the picker calls.
      const pinRes = await app.request("/api/me/integration-pins", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_package_id: INERT_AGENT,
          integration_package_id: INTEGRATION,
          connection_ids: [connB],
        }),
      });
      expect(pinRes.status).toBe(200);

      const after = await getResolution(INERT_AGENT, INTEGRATION);
      // The pin must now drive the verdict — not must_choose.
      expect(after.status).toBe("pinned");
      expect(after.resolved_connection_ids).toEqual([connB]);
      expect(after.member_pinned_connection_ids).toEqual([connB]);
      expect(connA).not.toBe(connB);
    });
  });

  // ─── PUT /:packageId/pins/:agentPackageId (admin org pin) ─

  describe("PUT /:packageId/pins/:agentPackageId", () => {
    it("ALLOW: admin pins a sharedWithOrg connection (returns the upserted pin)", async () => {
      const connId = await seedSharedConnection();

      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connection_ids: [connId] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { connection_ids: string[] };
      // Wire shape uses snake_case (IntegrationPin DTO).
      expect(body.connection_ids).toEqual([connId]);
    });

    it("ALLOW: admin pins a SET of connections, and the readiness reports all of them", async () => {
      const connA = await seedSharedConnection();
      const connB = await seedSharedConnection();

      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connection_ids: [connA, connB] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { connection_ids: string[] };
      expect([...body.connection_ids].sort()).toEqual([connA, connB].sort());

      const resolution = await getResolution(AGENT, INTEGRATION);
      expect([...resolution.admin_pinned_connection_ids].sort()).toEqual([connA, connB].sort());
    });

    it("ALLOW: a second PUT REPLACES the set rather than merging into it", async () => {
      const connA = await seedSharedConnection();
      const connB = await seedSharedConnection();
      const put = (ids: string[]) =>
        app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
          method: "PUT",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({ connection_ids: ids }),
        });

      await put([connA, connB]);
      const res = await put([connA]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connection_ids: string[] };
      expect(body.connection_ids).toEqual([connA]);

      const resolution = await getResolution(AGENT, INTEGRATION);
      expect(resolution.admin_pinned_connection_ids).toEqual([connA]);
    });

    it("DENY: 400 when the pinned set's labels collide — 200 once one is renamed", async () => {
      const put = (ids: string[]) =>
        app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
          method: "PUT",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({ connection_ids: ids }),
        });
      const a = await seedSharedConnection();
      const b = await seedSharedConnection();
      await app.request(`/api/integrations/${INTEGRATION}/connections/${b}`, {
        method: "PATCH",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ label: "collision" }),
      });
      await app.request(`/api/integrations/${INTEGRATION}/connections/${a}`, {
        method: "PATCH",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ label: "collision" }),
      });

      const clash = await put([a, b]);
      expect(clash.status).toBe(400);
      expect(((await clash.json()) as { detail: string }).detail).toMatch(
        /must have distinct labels/,
      );

      // Control: rename one and the identical request lands.
      await app.request(`/api/integrations/${INTEGRATION}/connections/${a}`, {
        method: "PATCH",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ label: "distinct" }),
      });
      expect((await put([a, b])).status).toBe(200);
    });

    it("DENY: 400 on an empty set, a repeated id, and a set over the cap", async () => {
      const connId = await seedSharedConnection();
      const put = (ids: string[]) =>
        app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
          method: "PUT",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({ connection_ids: ids }),
        });

      expect((await put([])).status).toBe(400);
      expect((await put([connId, connId])).status).toBe(400);
      const over = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION + 1 }, () =>
        crypto.randomUUID(),
      );
      expect((await put(over)).status).toBe(400);
      // Control: the singleton the other cases degenerate from still lands.
      expect((await put([connId])).status).toBe(200);
    });

    it("DENY: 400 when body uses camelCase keys (snake_case wire contract)", async () => {
      const connId = await seedSharedConnection();

      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connectionIds: [connId] }),
      });

      expect(res.status).toBe(400);
    });

    it("DENY: non-admin member gets 403 (lacks integrations:configure)", async () => {
      const connId = await seedSharedConnection();

      // Seed a second user + add them as a regular `member` of the same org.
      const member = await createTestUser({});
      await db.insert(organizationMembers).values({
        orgId: ctx.orgId,
        userId: member.id,
        role: "member",
      });

      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "PUT",
        headers: {
          Cookie: member.cookie,
          "X-Org-Id": ctx.orgId,
          "X-Space-Id": ctx.defaultSpaceId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ connection_ids: [connId] }),
      });

      // A member's space preset (`operator`) does not hold
      // `integrations:configure`, so the guard refuses.
      expect([401, 403]).toContain(res.status);
    });

    it("DENY: 401 without auth", async () => {
      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_ids: ["00000000-0000-0000-0000-000000000000"] }),
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── DELETE /:packageId/pins/:agentPackageId ──────────

  describe("DELETE /:packageId/pins/:agentPackageId", () => {
    it("ALLOW: admin removes a pin (204)", async () => {
      const connId = await seedSharedConnection();
      // Create via PUT first to have something to delete.
      await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connection_ids: [connId] }),
      });

      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);
    });

    it("returns 204 when the pin doesn't exist (idempotent)", async () => {
      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);
    });

    it("DENY: non-admin member gets 401/403", async () => {
      const member = await createTestUser({});
      await db.insert(organizationMembers).values({
        orgId: ctx.orgId,
        userId: member.id,
        role: "member",
      });

      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "DELETE",
        headers: {
          Cookie: member.cookie,
          "X-Org-Id": ctx.orgId,
          "X-Space-Id": ctx.defaultSpaceId,
        },
      });

      expect([401, 403]).toContain(res.status);
    });
  });

  // ─── GET /:packageId/pins ──────────────────────────────

  describe("GET /:packageId/pins", () => {
    it("returns the list of admin pins for the integration", async () => {
      const connId = await seedSharedConnection();
      // Create two pins (different agents) via PUT.
      await seedAgent({
        id: SECOND_AGENT,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: buildAgentManifest(SECOND_AGENT),
      });
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, SECOND_AGENT);

      for (const id of [AGENT, SECOND_AGENT]) {
        await app.request(`/api/integrations/${INTEGRATION}/pins/${id}`, {
          method: "PUT",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({ connection_ids: [connId] }),
        });
      }

      const res = await app.request(`/api/integrations/${INTEGRATION}/pins`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ packageId: string; connection_ids: string[] }>;
      };
      expect(body.data).toHaveLength(2);
      const agentIds = new Set(body.data.map((p) => p.packageId));
      expect(agentIds.has(AGENT)).toBe(true);
      expect(agentIds.has(SECOND_AGENT)).toBe(true);
    });

    it("returns an empty list when no pins exist", async () => {
      const res = await app.request(`/api/integrations/${INTEGRATION}/pins`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toEqual([]);
    });

    it("DENY: 401 without auth", async () => {
      const res = await app.request(`/api/integrations/${INTEGRATION}/pins`);
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /:packageId/consuming-agents ─────────────────

  describe("GET /:packageId/consuming-agents", () => {
    it("returns the list of installed agents that depend on this integration", async () => {
      await seedAgent({
        id: SECOND_AGENT,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: buildAgentManifest(SECOND_AGENT),
      });
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, SECOND_AGENT);

      const res = await app.request(`/api/integrations/${INTEGRATION}/consuming-agents`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ packageId: string; display_name: string }>;
      };
      expect(body.data.length).toBeGreaterThanOrEqual(2);
      const agentIds = new Set(body.data.map((a) => a.packageId));
      expect(agentIds.has(AGENT)).toBe(true);
      expect(agentIds.has(SECOND_AGENT)).toBe(true);
      // Wire shape: snake_case display_name.
      for (const entry of body.data) {
        expect(entry).toHaveProperty("display_name");
      }
    });

    it("DENY: 401 without auth", async () => {
      const res = await app.request(`/api/integrations/${INTEGRATION}/consuming-agents`);
      expect(res.status).toBe(401);
    });
  });
});
