// SPDX-License-Identifier: Apache-2.0

/**
 * /api/me/integration-pins — member-scope pin HTTP contract.
 *
 * Pins persist the member's "use this connection for this agent" preference
 * (layer 4 of the resolver cascade). The HTTP contract has three gates:
 *
 *   1. Auth: cookie-or-API-key required (no Appstrate-User end-user surface).
 *   2. Wire shape: PUT body is snake_case `{ agent_package_id,
 *      integration_package_id, connection_ids }`. The frontend serialiser was
 *      just fixed to match this — this file pins the backend gate so a future
 *      drift back to camelCase is caught.
 *   3. End-user 401 on PUT + DELETE (impersonated callers can't pin); end-user
 *      GET returns an empty list rather than 401 so the picker renders cleanly.
 *   4. A delegated credential is capped by its scope ceiling: the read needs
 *      `integrations:read`, the writes `integrations:connect`.
 *
 * Service-layer behaviour (own vs other member's connection, sharedWithOrg
 * fallback, the 6-layer cascade resolution) lives in
 * `services/integration-pins-service.test.ts` + `services/integration-
 * connection-resolver.test.ts`. This file pins the HTTP boundary only.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedEndUser, seedApiKey, seedSchedule } from "../../helpers/seed.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import type { ConnectionDeleteImpact } from "../../../src/services/me-connections.ts";
import { integrationConnections, schedules } from "@appstrate/db/schema";
import { inArray } from "drizzle-orm";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";

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
        spaceId: ctx.defaultSpaceId,
        userId,
        endUserId: null,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret" } }),
        scopesGranted: [],
        label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pinorg" });

    // Agent + integration must exist + be installed for validatePinTargets.
    await seedPackage({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      type: "agent",
      source: "local",
      draftManifest: buildAgentManifest(),
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
          connection_ids: [connectionId],
        }),
      });

      expect(res.status).toBe(200);
      // PUT response is the IntegrationPin wire shape (snake_case fields).
      const body = (await res.json()) as { connection_ids: string[] };
      expect(body.connection_ids).toEqual([connectionId]);
    });

    it("ALLOW: pins a SET of connections, replaced wholesale by the next PUT", async () => {
      const connA = await seedConnectionFor(ctx.user.id);
      const connB = await seedConnectionFor(ctx.user.id);
      const put = (ids: string[]) =>
        app.request("/api/me/integration-pins", {
          method: "PUT",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({
            agent_package_id: AGENT,
            integration_package_id: INTEGRATION,
            connection_ids: ids,
          }),
        });

      const both = await put([connA, connB]);
      expect(both.status).toBe(200);
      expect(
        [...((await both.json()) as { connection_ids: string[] }).connection_ids].sort(),
      ).toEqual([connA, connB].sort());

      const listed = await app.request(
        `/api/me/integration-pins?agent_package_id=${encodeURIComponent(AGENT)}`,
        { headers: authHeaders(ctx) },
      );
      const body = (await listed.json()) as { data: Array<{ connection_ids: string[] }> };
      expect(body.data).toHaveLength(1);
      expect([...body.data[0]!.connection_ids].sort()).toEqual([connA, connB].sort());

      // A PUT is a replacement, never a merge.
      await put([connB]);
      const after = await app.request(
        `/api/me/integration-pins?agent_package_id=${encodeURIComponent(AGENT)}`,
        { headers: authHeaders(ctx) },
      );
      const afterBody = (await after.json()) as { data: Array<{ connection_ids: string[] }> };
      expect(afterBody.data[0]!.connection_ids).toEqual([connB]);
    });

    it("DENY: 400 on an empty set and on a set over the cap", async () => {
      const put = (ids: string[]) =>
        app.request("/api/me/integration-pins", {
          method: "PUT",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({
            agent_package_id: AGENT,
            integration_package_id: INTEGRATION,
            connection_ids: ids,
          }),
        });

      expect((await put([])).status).toBe(400);
      const over = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION + 1 }, () =>
        crypto.randomUUID(),
      );
      expect((await put(over)).status).toBe(400);
      // Control: a legal singleton reaches the service and lands.
      const connId = await seedConnectionFor(ctx.user.id);
      expect((await put([connId])).status).toBe(200);
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
      expect(fieldPaths).toContain("connection_ids");
    });

    it("DENY: 400 when a connection id is not a UUID", async () => {
      const res = await app.request("/api/me/integration-pins", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_package_id: AGENT,
          integration_package_id: INTEGRATION,
          connection_ids: ["not-a-uuid"],
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
          connection_ids: ["00000000-0000-0000-0000-000000000000"],
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
          connection_ids: [connectionId],
        }),
      });
      expect(putRes.status).toBe(200);

      const res = await app.request(
        `/api/me/integration-pins?agent_package_id=${encodeURIComponent(AGENT)}`,
        { headers: authHeaders(ctx) },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ connection_ids: string[] }> };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.connection_ids).toEqual([connectionId]);
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
          connection_ids: [connectionId],
        }),
      });

      const qs = new URLSearchParams({
        agent_package_id: AGENT,
        integration_package_id: INTEGRATION,
      });
      const res = await app.request(`/api/me/integration-pins?${qs.toString()}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);

      // Subsequent GET returns empty list.
      const list = await app.request(
        `/api/me/integration-pins?agent_package_id=${encodeURIComponent(AGENT)}`,
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
        spaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        externalId: "ext-eu-pin",
      });
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        name: "pin-test-key-put",
        scopes: ["integrations:connect"],
      });
      const connectionId = await seedConnectionFor(ctx.user.id);

      const res = await app.request("/api/me/integration-pins", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiKey.rawKey}`,
          "X-Space-Id": ctx.defaultSpaceId,
          "Appstrate-User": endUser.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_package_id: AGENT,
          integration_package_id: INTEGRATION,
          connection_ids: [connectionId],
        }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { detail?: string };
      expect(JSON.stringify(body)).toMatch(/end-user/i);
    });

    it("DELETE returns 401 when an end-user impersonates", async () => {
      const endUser = await seedEndUser({
        spaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        externalId: "ext-eu-pin-del",
      });
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        name: "pin-test-key-del",
        scopes: ["integrations:connect"],
      });

      const qs = new URLSearchParams({
        agent_package_id: AGENT,
        integration_package_id: INTEGRATION,
      });
      const res = await app.request(`/api/me/integration-pins?${qs.toString()}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${apiKey.rawKey}`,
          "X-Space-Id": ctx.defaultSpaceId,
          "Appstrate-User": endUser.id,
        },
      });

      expect(res.status).toBe(401);
    });

    it("GET returns 200 + empty list when an end-user impersonates (no special-case for picker UI)", async () => {
      const endUser = await seedEndUser({
        spaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        externalId: "ext-eu-pin-get",
      });
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        name: "pin-test-key-get",
        scopes: ["integrations:read"],
      });

      const res = await app.request(
        `/api/me/integration-pins?agent_package_id=${encodeURIComponent(AGENT)}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey.rawKey}`,
            "X-Space-Id": ctx.defaultSpaceId,
            "Appstrate-User": endUser.id,
          },
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toEqual([]);
    });
  });

  // ─── Credential ceiling ────────────────────────────────

  describe("credential ceiling", () => {
    const listPath = `/api/me/integration-pins?agent_package_id=${encodeURIComponent(AGENT)}`;
    const deleteQuery = new URLSearchParams({
      agent_package_id: AGENT,
      integration_package_id: INTEGRATION,
    });
    const deletePath = `/api/me/integration-pins?${deleteQuery.toString()}`;

    async function keyHeaders(scopes: string[]): Promise<Record<string, string>> {
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes,
      });
      return { Authorization: `Bearer ${apiKey.rawKey}`, "X-Space-Id": ctx.defaultSpaceId };
    }

    function putPin(headers: Record<string, string>, connectionId: string) {
      return app.request("/api/me/integration-pins", {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_package_id: AGENT,
          integration_package_id: INTEGRATION,
          connection_ids: [connectionId],
        }),
      });
    }

    /** The pins as the owner's own session sees them — the row, not the response. */
    async function pinnedConnections(): Promise<string[]> {
      const res = await app.request(listPath, { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ connection_ids: string[] }> };
      return body.data.flatMap((pin) => pin.connection_ids);
    }

    it("PUT: a key without integrations:connect is refused and pins nothing", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      const res = await putPin(await keyHeaders(["integrations:read"]), connectionId);
      expect(res.status).toBe(403);
      expect(await pinnedConnections()).toEqual([]);
    });

    it("PUT: a key with integrations:connect pins", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      const res = await putPin(await keyHeaders(["integrations:connect"]), connectionId);
      expect(res.status).toBe(200);
      expect(await pinnedConnections()).toEqual([connectionId]);
    });

    it("PUT: a cookie session, which carries no ceiling, pins", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      expect((await putPin(authHeaders(ctx), connectionId)).status).toBe(200);
      expect(await pinnedConnections()).toEqual([connectionId]);
    });

    it("DELETE: a key without integrations:connect is refused and the pin survives", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      expect((await putPin(authHeaders(ctx), connectionId)).status).toBe(200);
      const headers = await keyHeaders(["integrations:read", "integrations:disconnect"]);
      const res = await app.request(deletePath, { method: "DELETE", headers });
      expect(res.status).toBe(403);
      expect(await pinnedConnections()).toEqual([connectionId]);
    });

    it("DELETE: a key with integrations:connect clears the pin", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      expect((await putPin(authHeaders(ctx), connectionId)).status).toBe(200);
      const headers = await keyHeaders(["integrations:connect"]);
      const res = await app.request(deletePath, { method: "DELETE", headers });
      expect(res.status).toBe(204);
      expect(await pinnedConnections()).toEqual([]);
    });

    it("DELETE: a cookie session, which carries no ceiling, clears the pin", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      expect((await putPin(authHeaders(ctx), connectionId)).status).toBe(200);
      const res = await app.request(deletePath, { method: "DELETE", headers: authHeaders(ctx) });
      expect(res.status).toBe(204);
      expect(await pinnedConnections()).toEqual([]);
    });

    it("GET: a key without integrations:read is refused", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      expect((await putPin(authHeaders(ctx), connectionId)).status).toBe(200);
      const headers = await keyHeaders(["integrations:connect"]);
      expect((await app.request(listPath, { headers })).status).toBe(403);
    });

    it("GET: a key with integrations:read lists the pin", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      expect((await putPin(authHeaders(ctx), connectionId)).status).toBe(200);
      const res = await app.request(listPath, { headers: await keyHeaders(["integrations:read"]) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ connection_ids: string[] }> };
      expect(body.data.map((pin) => pin.connection_ids)).toEqual([[connectionId]]);
    });
  });
  // ─── GET /connections/:id/delete-impact — what a delete would rewrite ───────

  describe("GET /api/me/connections/:connectionId/delete-impact", () => {
    const OTHER_AGENT = "@pinorg/other-agent";

    async function impactOf(
      connectionId: string,
      headers = authHeaders(ctx),
    ): Promise<ConnectionDeleteImpact> {
      const res = await app.request(`/api/me/connections/${connectionId}/delete-impact`, {
        headers,
      });
      expect(res.status).toBe(200);
      return (await res.json()) as ConnectionDeleteImpact;
    }

    async function putPin(connectionIds: string[], agent = AGENT) {
      const res = await app.request("/api/me/integration-pins", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_package_id: agent,
          integration_package_id: INTEGRATION,
          connection_ids: connectionIds,
        }),
      });
      expect(res.status).toBe(200);
    }

    function scheduleFor(
      connectionIds: string[],
      owner: { userId?: string; endUserId?: string },
      name: string | null = null,
      enabled = true,
    ) {
      return seedSchedule({
        packageId: AGENT,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        name,
        enabled,
        ...owner,
        connectionOverrides: { [INTEGRATION]: connectionIds },
      });
    }

    beforeEach(async () => {
      await seedPackage({
        id: OTHER_AGENT,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        type: "agent",
        source: "local",
        draftManifest: { ...buildAgentManifest(), name: OTHER_AGENT, display_name: "Other" },
      });
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, OTHER_AGENT);
    });

    it("lists the caller's pins and schedules naming the connection, with each set's size", async () => {
      const [web, db2, spare] = [
        await seedConnectionFor(ctx.user.id),
        await seedConnectionFor(ctx.user.id),
        await seedConnectionFor(ctx.user.id),
      ];
      await putPin([web!, db2!]);
      await putPin([db2!], OTHER_AGENT);
      const monday = await scheduleFor([db2!], { userId: ctx.user.id }, "Lundi");

      expect(await impactOf(db2!)).toEqual({
        pins: [
          {
            agent_package_id: AGENT,
            agent_display_name: "Pin Test Agent",
            integration_package_id: INTEGRATION,
            connection_count: 2,
          },
          {
            agent_package_id: OTHER_AGENT,
            agent_display_name: "Other",
            integration_package_id: INTEGRATION,
            connection_count: 1,
          },
        ],
        schedules: [
          {
            scheduleId: monday.id,
            schedule_name: "Lundi",
            agent_package_id: AGENT,
            agent_display_name: "Pin Test Agent",
            integration_package_id: INTEGRATION,
            connection_count: 1,
            disables: true,
          },
        ],
      });
      // A connection nothing names lists nothing.
      expect(await impactOf(spare!)).toEqual({ pins: [], schedules: [] });
    });

    it("lists exactly the pins and schedules the delete then rewrites", async () => {
      const [web, gone] = [
        await seedConnectionFor(ctx.user.id),
        await seedConnectionFor(ctx.user.id),
      ];
      await putPin([web!, gone!]);
      await putPin([gone!], OTHER_AGENT);
      const shrinks = await scheduleFor([web!, gone!], { userId: ctx.user.id });
      const resets = await scheduleFor([gone!], { userId: ctx.user.id });
      const announced = await impactOf(gone!);
      expect(announced.pins.map((p) => p.agent_package_id)).toEqual([AGENT, OTHER_AGENT]);
      expect(
        Object.fromEntries(announced.schedules.map((s) => [s.scheduleId, s.disables])),
      ).toEqual({ [shrinks.id]: false, [resets.id]: true });

      const del = await app.request(`/api/me/connections/${gone}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(del.status).toBe(204);

      for (const pin of announced.pins) {
        const res = await app.request(
          `/api/me/integration-pins?agent_package_id=${encodeURIComponent(pin.agent_package_id)}`,
          { headers: authHeaders(ctx) },
        );
        const after = ((await res.json()) as { data: { connection_ids: string[] }[] }).data;
        const left = after.flatMap((p) => p.connection_ids);
        expect(left).toHaveLength(pin.connection_count - 1);
        expect(left).not.toContain(gone);
      }
      const rows = await db
        .select({
          id: schedules.id,
          connectionOverrides: schedules.connectionOverrides,
          enabled: schedules.enabled,
          nextRunAt: schedules.nextRunAt,
        })
        .from(schedules)
        .where(inArray(schedules.id, [shrinks.id, resets.id]));
      const after = new Map(rows.map((r) => [r.id, r]));
      // A set that only shrinks stays armed; an emptied one disables its schedule instead of
      // letting it fall back to another account unattended.
      expect(after.get(shrinks.id)).toMatchObject({
        connectionOverrides: { [INTEGRATION]: [web!] },
        enabled: true,
      });
      expect(after.get(resets.id)).toMatchObject({
        connectionOverrides: null,
        enabled: false,
        nextRunAt: null,
      });
      expect(await impactOf(gone!)).toEqual({ pins: [], schedules: [] });
    });

    it("does not announce a disable for a schedule that is already off", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      const off = await scheduleFor([connectionId], { userId: ctx.user.id }, null, false);
      expect((await impactOf(connectionId)).schedules).toEqual([
        expect.objectContaining({ scheduleId: off.id, connection_count: 1, disables: false }),
      ]);
    });

    it("leaves out a colleague's schedule, which the delete does not rewrite", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      const colleague = await createTestUser();
      await addOrgMember(ctx.orgId, colleague.id);
      await scheduleFor([connectionId], { userId: colleague.id });
      expect(await impactOf(connectionId)).toEqual({ pins: [], schedules: [] });
    });

    it("is empty for an id that is not a UUID", async () => {
      expect(await impactOf("not-a-uuid")).toEqual({ pins: [], schedules: [] });
    });

    it("gives an end user no pins, only its own schedules", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      await putPin([connectionId]);
      await scheduleFor([connectionId], { userId: ctx.user.id });
      const endUser = await seedEndUser({
        spaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        externalId: "ext-eu-delete-impact",
      });
      const own = await scheduleFor([connectionId], { endUserId: endUser.id });
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        name: "delete-impact-key",
        scopes: ["integrations:read"],
      });
      const impact = await impactOf(connectionId, {
        Authorization: `Bearer ${apiKey.rawKey}`,
        "X-Space-Id": ctx.defaultSpaceId,
        "Appstrate-User": endUser.id,
      });
      expect(impact.pins).toEqual([]);
      expect(impact.schedules.map((s) => s.scheduleId)).toEqual([own.id]);
    });
  });
});
