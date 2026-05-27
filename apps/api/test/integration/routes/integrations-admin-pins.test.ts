// SPDX-License-Identifier: Apache-2.0

/**
 * Admin integration surface — HTTP boundary tests.
 *
 * Three endpoints drive the integration detail page's admin section:
 *
 *   GET    /api/integrations/:packageId/agent-resolution/:agentPackageId
 *          Single-source verdict for the agent-page picker (resolver cascade
 *          + candidate list + pin/blocked state). The SPA renders this
 *          verbatim — no client-side re-implementation of the cascade.
 *
 *   PUT    /api/integrations/:packageId/pins/:agentPackageId
 *   DELETE /api/integrations/:packageId/pins/:agentPackageId
 *          Admin org-level pins (sharedWithOrg-required, layer 1 of the
 *          resolver cascade). Admin-only via `requirePermission` +
 *          `assertOrgAdmin` defence-in-depth.
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
import { installPackage } from "../../../src/services/application-packages.ts";
import { integrationConnections, organizationMembers } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

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
    schema_version: "2.0",
    display_name: `Admin Test Agent ${name}`,
    dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
    integrations: { [INTEGRATION]: { tools: ["search"] } },
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
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        endUserId: null,
        credentialsEncrypted: encryptCredentials({ api_key: "secret" }),
        scopesGranted: [],
        sharedWithOrg: true,
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
        applicationId: ctx.defaultAppId,
        userId,
        endUserId: null,
        credentialsEncrypted: encryptCredentials({ api_key: "secret" }),
        scopesGranted: [],
        sharedWithOrg: false,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "adminorg" });

    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest(AGENT),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);

    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: buildIntegrationManifest(),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, INTEGRATION);
  });

  // ─── GET /agent-resolution/:agentPackageId ─────────────

  describe("GET /:packageId/agent-resolution/:agentPackageId", () => {
    it("returns 200 with the full resolution verdict shape", async () => {
      const connId = await seedPrivateConnectionFor(ctx.user.id);

      const res = await app.request(`/api/integrations/${INTEGRATION}/agent-resolution/${AGENT}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        resolved_connection_id: string | null;
        resolved_missing_scopes: string[];
        resolved_owned_by_actor: boolean;
        admin_pinned_connection_id: string | null;
        member_pinned_connection_id: string | null;
        org_default_connection_id: string | null;
        org_default_enforced: boolean;
        can_add_connection: boolean;
        candidates: Array<{ id: string; is_own: boolean; missing_scopes: string[] }>;
      };

      // Wire-shape contract — all fields present, snake_case.
      expect(body).toHaveProperty("status");
      expect(body).toHaveProperty("resolved_connection_id");
      expect(body).toHaveProperty("resolved_missing_scopes");
      expect(body).toHaveProperty("resolved_owned_by_actor");
      expect(body).toHaveProperty("admin_pinned_connection_id");
      expect(body).toHaveProperty("member_pinned_connection_id");
      expect(body).toHaveProperty("org_default_connection_id");
      expect(body).toHaveProperty("org_default_enforced");
      expect(body).toHaveProperty("can_add_connection");
      expect(Array.isArray(body.candidates)).toBe(true);

      // With one private connection on the actor and no pin/default:
      // resolver picks it auto → status="auto", resolved=owned connection.
      expect(body.status).toBe("auto");
      expect(body.resolved_connection_id).toBe(connId);
      expect(body.resolved_owned_by_actor).toBe(true);
    });

    it("returns 'none' status when actor has no accessible connection", async () => {
      // No connection seeded — picker should surface "none".
      const res = await app.request(`/api/integrations/${INTEGRATION}/agent-resolution/${AGENT}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; candidates: unknown[] };
      expect(body.status).toBe("none");
      expect(body.candidates).toEqual([]);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(`/api/integrations/${INTEGRATION}/agent-resolution/${AGENT}`);
      expect(res.status).toBe(401);
    });
  });

  // ─── PUT /:packageId/pins/:agentPackageId (admin org pin) ─

  describe("PUT /:packageId/pins/:agentPackageId", () => {
    it("ALLOW: admin pins a sharedWithOrg connection (returns the upserted pin)", async () => {
      const connId = await seedSharedConnection();

      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: connId }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { connection_id: string };
      // Wire shape uses snake_case (IntegrationPin DTO).
      expect(body.connection_id).toBe(connId);
    });

    it("DENY: 400 when body uses camelCase keys (snake_case wire contract)", async () => {
      const connId = await seedSharedConnection();

      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: connId }),
      });

      expect(res.status).toBe(400);
    });

    it("DENY: non-admin member gets 403 (defence-in-depth assertOrgAdmin)", async () => {
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
          "X-Application-Id": ctx.defaultAppId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ connection_id: connId }),
      });

      // RBAC denies via integrations:install scope OR assertOrgAdmin
      // throws — either way the route refuses.
      expect([401, 403]).toContain(res.status);
    });

    it("DENY: 401 without auth", async () => {
      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: "00000000-0000-0000-0000-000000000000" }),
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── DELETE /:packageId/pins/:agentPackageId ──────────

  describe("DELETE /:packageId/pins/:agentPackageId", () => {
    it("ALLOW: admin removes a pin (deleted=true)", async () => {
      const connId = await seedSharedConnection();
      // Create via PUT first to have something to delete.
      await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: connId }),
      });

      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted: boolean };
      expect(body.deleted).toBe(true);
    });

    it("returns deleted=false when the pin doesn't exist (idempotent)", async () => {
      const res = await app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted: boolean };
      expect(body.deleted).toBe(false);
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
          "X-Application-Id": ctx.defaultAppId,
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
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: buildAgentManifest(SECOND_AGENT),
      });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, SECOND_AGENT);

      for (const id of [AGENT, SECOND_AGENT]) {
        await app.request(`/api/integrations/${INTEGRATION}/pins/${id}`, {
          method: "PUT",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({ connection_id: connId }),
        });
      }

      const res = await app.request(`/api/integrations/${INTEGRATION}/pins`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ packageId: string; connection_id: string }>;
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
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: buildAgentManifest(SECOND_AGENT),
      });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, SECOND_AGENT);

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
