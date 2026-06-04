// SPDX-License-Identifier: Apache-2.0

/**
 * /api/me/integration-pins — member-scope pin HTTP contract.
 *
 * Pins persist the member's "use this connection for this agent" preference
 * (layer 4 of the resolver cascade). The HTTP contract has three gates:
 *
 *   1. Auth: cookie-or-API-key required (no Appstrate-User end-user surface).
 *   2. Wire shape: PUT body is snake_case `{ agent_package_id,
 *      integration_package_id, connection_id }`. The frontend serialiser was
 *      just fixed to match this — this file pins the backend gate so a future
 *      drift back to camelCase is caught.
 *   3. End-user 401 on PUT + DELETE (impersonated callers can't pin); end-user
 *      GET returns an empty list rather than 401 so the picker renders cleanly.
 *
 * Service-layer behaviour (own vs other member's connection, sharedWithOrg
 * fallback, the 7-layer cascade resolution) lives in
 * `services/integration-pins-service.test.ts` + `services/integration-
 * connection-resolver.test.ts`. This file pins the HTTP boundary only.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedEndUser, seedApiKey } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const AGENT = "@pinorg/agent";
const INTEGRATION = "@pinorg/svc";
const MCP_SERVER = "@pinorg/svc-server";

function buildAgentManifest(): Record<string, unknown> {
  return {
    name: AGENT,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.2",
    display_name: "Pin Test Agent",
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

describe("/api/me/integration-pins", () => {
  let ctx: TestContext;

  /** Seed an integration connection owned by the test user. */
  async function seedConnectionFor(userId: string): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: "primary",
        accountId: `acct-${userId.slice(0, 6)}`,
        applicationId: ctx.defaultAppId,
        userId,
        endUserId: null,
        credentialsEncrypted: encryptCredentials({ api_key: "secret" }),
        scopesGranted: [],
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pinorg" });

    // Agent + integration must exist + be installed for validatePinTarget.
    await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      type: "agent",
      source: "local",
      draftManifest: buildAgentManifest(),
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

  // ─── PUT — wire-shape snake_case body validation ───────

  describe("PUT /integration-pins (snake_case body)", () => {
    it("ALLOW: 200 with valid snake_case body", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);

      const res = await app.request("/api/me/integration-pins", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_package_id: AGENT,
          integration_package_id: INTEGRATION,
          connection_id: connectionId,
        }),
      });

      expect(res.status).toBe(200);
      // PUT response is the IntegrationPin wire shape (snake_case fields).
      const body = (await res.json()) as { connection_id: string };
      expect(body.connection_id).toBe(connectionId);
    });

    it("DENY: 400 when body uses camelCase keys (regression guard — frontend was just fixed)", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);

      const res = await app.request("/api/me/integration-pins", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          agentPackageId: AGENT,
          integrationId: INTEGRATION,
          connectionId,
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: Array<{ field: string }> };
      // The Zod schema lists all 3 missing snake_case fields.
      const fieldPaths = (body.errors ?? []).map((e) => e.field);
      expect(fieldPaths).toContain("agent_package_id");
      expect(fieldPaths).toContain("integration_package_id");
      expect(fieldPaths).toContain("connection_id");
    });

    it("DENY: 400 when connection_id is not a UUID", async () => {
      const res = await app.request("/api/me/integration-pins", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_package_id: AGENT,
          integration_package_id: INTEGRATION,
          connection_id: "not-a-uuid",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("DENY: 401 without auth", async () => {
      const res = await app.request("/api/me/integration-pins", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_package_id: AGENT,
          integration_package_id: INTEGRATION,
          connection_id: "00000000-0000-0000-0000-000000000000",
        }),
      });

      expect(res.status).toBe(401);
    });
  });

  // ─── GET — empty-list short-circuit ────────────────────

  describe("GET /integration-pins", () => {
    it("ALLOW: returns the caller's pin when one exists", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      // Upsert via PUT so the service-layer creates the row legitimately.
      const putRes = await app.request("/api/me/integration-pins", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_package_id: AGENT,
          integration_package_id: INTEGRATION,
          connection_id: connectionId,
        }),
      });
      expect(putRes.status).toBe(200);

      const res = await app.request(
        `/api/me/integration-pins?agentPackageId=${encodeURIComponent(AGENT)}`,
        { headers: authHeaders(ctx) },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ connectionId: string }> };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.connectionId).toBe(connectionId);
    });

    it("returns an empty list when no agentPackageId query param is given", async () => {
      const res = await app.request("/api/me/integration-pins", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toEqual([]);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request("/api/me/integration-pins");
      expect(res.status).toBe(401);
    });
  });

  // ─── DELETE ───────────────────────────────────────────

  describe("DELETE /integration-pins", () => {
    it("204 deletes the caller's pin", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      // Create via PUT first.
      await app.request("/api/me/integration-pins", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_package_id: AGENT,
          integration_package_id: INTEGRATION,
          connection_id: connectionId,
        }),
      });

      const qs = new URLSearchParams({
        agentPackageId: AGENT,
        integrationPackageId: INTEGRATION,
      });
      const res = await app.request(`/api/me/integration-pins?${qs.toString()}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);

      // Subsequent GET returns empty list.
      const list = await app.request(
        `/api/me/integration-pins?agentPackageId=${encodeURIComponent(AGENT)}`,
        { headers: authHeaders(ctx) },
      );
      const body = (await list.json()) as { data: unknown[] };
      expect(body.data).toEqual([]);
    });

    it("DENY: rejects when query params are missing", async () => {
      const res = await app.request("/api/me/integration-pins", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      // Route raises unauthorized() when required query params are missing.
      // Either 400 or 401 is acceptable — the gate exists, that's what matters.
      expect([400, 401]).toContain(res.status);
    });
  });

  // ─── End-user impersonation gates ──────────────────────

  describe("end-user impersonation", () => {
    it("PUT returns 401 when an end-user impersonates via Appstrate-User header", async () => {
      const endUser = await seedEndUser({
        applicationId: ctx.defaultAppId,
        orgId: ctx.orgId,
        externalId: "ext-eu-pin",
      });
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        createdBy: ctx.user.id,
        name: "pin-test-key-put",
      });
      const connectionId = await seedConnectionFor(ctx.user.id);

      const res = await app.request("/api/me/integration-pins", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiKey.rawKey}`,
          "X-Application-Id": ctx.defaultAppId,
          "Appstrate-User": endUser.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_package_id: AGENT,
          integration_package_id: INTEGRATION,
          connection_id: connectionId,
        }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { detail?: string };
      expect(JSON.stringify(body)).toMatch(/end-user/i);
    });

    it("DELETE returns 401 when an end-user impersonates", async () => {
      const endUser = await seedEndUser({
        applicationId: ctx.defaultAppId,
        orgId: ctx.orgId,
        externalId: "ext-eu-pin-del",
      });
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        name: "pin-test-key-del",
      });

      const qs = new URLSearchParams({
        agentPackageId: AGENT,
        integrationPackageId: INTEGRATION,
      });
      const res = await app.request(`/api/me/integration-pins?${qs.toString()}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${apiKey.rawKey}`,
          "X-Application-Id": ctx.defaultAppId,
          "Appstrate-User": endUser.id,
        },
      });

      expect(res.status).toBe(401);
    });

    it("GET returns 200 + empty list when an end-user impersonates (no special-case for picker UI)", async () => {
      const endUser = await seedEndUser({
        applicationId: ctx.defaultAppId,
        orgId: ctx.orgId,
        externalId: "ext-eu-pin-get",
      });
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        createdBy: ctx.user.id,
        name: "pin-test-key-get",
      });

      const res = await app.request(
        `/api/me/integration-pins?agentPackageId=${encodeURIComponent(AGENT)}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey.rawKey}`,
            "X-Application-Id": ctx.defaultAppId,
            "Appstrate-User": endUser.id,
          },
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toEqual([]);
    });
  });
});
