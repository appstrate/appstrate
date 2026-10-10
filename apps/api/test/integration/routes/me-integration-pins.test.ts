// SPDX-License-Identifier: Apache-2.0

/**
 * /api/me/integration-pins — member-scope pin HTTP contract.
 *
 * Pins persist the member's "use this connection for this agent" preference
 * (layer 4 of the resolver cascade). The HTTP contract has three gates:
 *
 *   1. Auth: cookie-or-API-key required (no Appstrate-User end-user surface).
 *   2. Addressing: PUT and DELETE name the pin in the path,
 *      `/api/me/integration-pins/{agent}/integrations/{integration}`, like
 *      the admin pins; the PUT body is `{ connection_ids }` alone.
 *   3. End-user 403 on PUT + DELETE (a valid credential with no member-pin
 *      surface, not a dead one); end-user GET returns an empty list so the
 *      picker renders cleanly.
 *   4. A delegated credential is capped by its scope ceiling: the read needs
 *      `integrations:read`, the writes `integrations:connect`.
 *
 * Service-layer behaviour (own vs other member's connection, shared
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
import {
  seedPackage,
  seedEndUser,
  seedApiKey,
  seedSchedule,
  seedSpace,
} from "../../helpers/seed.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import type { ConnectionDeleteImpact } from "../../../src/services/me-connections.ts";
import {
  auditEvents,
  integrationConnections,
  integrationPins,
  schedules,
} from "@appstrate/db/schema";
import { asc, eq } from "drizzle-orm";
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

  /** Seed an integration connection owned by `userId` (or `endUserId`), private unless `shared`. */
  async function seedConnectionFor(
    userId: string | null,
    opts: { endUserId?: string; spaceId?: string; shared?: boolean } = {},
  ): Promise<string> {
    const spaceId = opts.spaceId ?? ctx.defaultSpaceId;
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: "primary",
        accountId: `acct-${(userId ?? opts.endUserId)!.slice(0, 6)}`,
        orgId: ctx.orgId,
        spaceId,
        userId,
        endUserId: opts.endUserId ?? null,
        sharedSpaceIds: opts.shared ? [spaceId] : [],
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret" } }),
        scopesGranted: [],
        label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  const pinPath = (agent = AGENT) =>
    `/api/me/integration-pins/${agent}/integrations/${INTEGRATION}`;

  function putPin(connectionIds: string[], headers = authHeaders(ctx), agent = AGENT) {
    return app.request(pinPath(agent), {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ connection_ids: connectionIds }),
    });
  }

  function deletePin(headers = authHeaders(ctx)) {
    return app.request(pinPath(), { method: "DELETE", headers });
  }

  /** The pin audit rows, oldest first. */
  async function pinAudits(action: string) {
    return db
      .select({
        resourceId: auditEvents.resourceId,
        before: auditEvents.before,
        after: auditEvents.after,
      })
      .from(auditEvents)
      .where(eq(auditEvents.action, action))
      .orderBy(asc(auditEvents.id));
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

  describe("PUT /integration-pins/{agent}/integrations/{integration}", () => {
    it("ALLOW: 200 with valid snake_case body", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);

      const res = await putPin([connectionId]);

      expect(res.status).toBe(200);
      // PUT response is the IntegrationPin wire shape (snake_case fields).
      const body = (await res.json()) as { connection_ids: string[] };
      expect(body.connection_ids).toEqual([connectionId]);
    });

    it("ALLOW: pins a SET of connections", async () => {
      const connA = await seedConnectionFor(ctx.user.id);
      const connB = await seedConnectionFor(ctx.user.id);

      const both = await putPin([connA, connB]);
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
    });

    // One 404 for every id the caller may not pin, so a colleague's uuid cannot be probed.
    it("DENY: 404 not_found on a colleague's private connection, and the pin stays as it was", async () => {
      const own = await seedConnectionFor(ctx.user.id);
      expect((await putPin([own])).status).toBe(200);
      const colleague = await createTestUser();
      await addOrgMember(ctx.orgId, colleague.id);
      const theirs = await seedConnectionFor(colleague.id);

      const res = await putPin([theirs]);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("not_found");
      const listed = await app.request(
        `/api/me/integration-pins?agent_package_id=${encodeURIComponent(AGENT)}`,
        { headers: authHeaders(ctx) },
      );
      const body = (await listed.json()) as { data: Array<{ connection_ids: string[] }> };
      expect(body.data.map((pin) => pin.connection_ids)).toEqual([[own]]);
    });

    it("DENY: 400 on a set over the cap", async () => {
      const over = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION + 1 }, () =>
        crypto.randomUUID(),
      );
      expect((await putPin(over)).status).toBe(400);
      // Control: a legal singleton reaches the service and lands.
      const connId = await seedConnectionFor(ctx.user.id);
      expect((await putPin([connId])).status).toBe(200);
    });

    it("ALLOW: an empty set pins the caller to no connection", async () => {
      const connId = await seedConnectionFor(ctx.user.id);
      expect((await putPin([connId])).status).toBe(200);

      const res = await putPin([]);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { connection_ids: string[] }).connection_ids).toEqual([]);
      const [row] = await db
        .select({ connectionIds: integrationPins.connectionIds })
        .from(integrationPins)
        .where(eq(integrationPins.userId, ctx.user.id));
      expect(row!.connectionIds).toEqual([]);
      // Audited as a set, not as the absence of a pin.
      const [, cleared] = await pinAudits("integration.member_pin.upserted");
      expect(cleared!.after).toEqual({ connectionIds: [] });
    });

    it("ALLOW: an empty set on a required integration — the run it governs is refused", async () => {
      const REQUIRED_AGENT = "@pinorg/agent-required";
      const manifest = buildAgentManifest();
      await seedPackage({
        id: REQUIRED_AGENT,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        type: "agent",
        source: "local",
        draftManifest: {
          ...manifest,
          name: REQUIRED_AGENT,
          integrations_configuration: { [INTEGRATION]: { tools: ["search"], required: true } },
        },
      });
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, REQUIRED_AGENT);

      expect((await putPin([], authHeaders(ctx), REQUIRED_AGENT)).status).toBe(200);
      const readiness = await app.request(`/api/agents/${REQUIRED_AGENT}/connection-readiness`, {
        headers: authHeaders(ctx),
      });
      expect(((await readiness.json()) as { blocks_run: boolean }).blocks_run).toBe(true);

      const run = await app.request(`/api/agents/${REQUIRED_AGENT}/run?version=draft`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(run.status).toBe(409);
      const body = (await run.json()) as { errors: { field: string; code: string }[] };
      expect(body.errors.map((e) => [e.field, e.code])).toEqual([
        [`integrations.${INTEGRATION}`, "required_integration_unbound"],
      ]);
    });

    it("DENY: 400 when the body still names the ids the path now carries", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);

      const res = await app.request(pinPath(), {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_package_id: AGENT,
          integration_package_id: INTEGRATION,
          connection_ids: [connectionId],
        }),
      });

      expect(res.status).toBe(400);
      // Control: the same set, the ids in the path only.
      expect((await putPin([connectionId])).status).toBe(200);
    });

    it("audits every write with the set before and after, under the admin pins' resource id", async () => {
      const first = await seedConnectionFor(ctx.user.id);
      const second = await seedConnectionFor(ctx.user.id);
      expect((await putPin([first])).status).toBe(200);
      expect((await putPin([second])).status).toBe(200);
      expect((await deletePin()).status).toBe(204);

      const resourceId = `${INTEGRATION}#${AGENT}`;
      expect(await pinAudits("integration.member_pin.upserted")).toEqual([
        { resourceId, before: null, after: { connectionIds: [first] } },
        { resourceId, before: { connectionIds: [first] }, after: { connectionIds: [second] } },
      ]);
      expect(await pinAudits("integration.member_pin.deleted")).toEqual([
        { resourceId, before: { connectionIds: [second] }, after: null },
      ]);
    });

    it("DENY: 400 when a connection id is not a UUID", async () => {
      expect((await putPin(["not-a-uuid"])).status).toBe(400);
    });

    it("DENY: 401 without auth", async () => {
      expect((await putPin(["00000000-0000-0000-0000-000000000000"], {})).status).toBe(401);
    });
  });

  // ─── GET — empty-list short-circuit ────────────────────

  describe("GET /integration-pins", () => {
    it("ALLOW: returns the caller's pin when one exists", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      // Upsert via PUT so the service-layer creates the row legitimately.
      expect((await putPin([connectionId])).status).toBe(200);

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
      expect((await putPin([connectionId])).status).toBe(200);

      const res = await deletePin();

      expect(res.status).toBe(204);

      // Subsequent GET returns empty list.
      const list = await app.request(
        `/api/me/integration-pins?agent_package_id=${encodeURIComponent(AGENT)}`,
        { headers: authHeaders(ctx) },
      );
      const body = (await list.json()) as { data: unknown[] };
      expect(body.data).toEqual([]);
    });
  });

  // ─── End-user impersonation gates ──────────────────────

  describe("end-user impersonation", () => {
    it("PUT returns 403 forbidden when an end-user impersonates via Appstrate-User header", async () => {
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

      const res = await putPin([connectionId], {
        Authorization: `Bearer ${apiKey.rawKey}`,
        "X-Space-Id": ctx.defaultSpaceId,
        "Appstrate-User": endUser.id,
      });

      expect(res.status).toBe(403);
      expect(res.headers.get("WWW-Authenticate")).toBeNull();
      const body = (await res.json()) as { code?: string; detail?: string };
      expect(body.code).toBe("forbidden");
      expect(body.detail).toMatch(/end-user/i);
    });

    it("DELETE returns 403 forbidden when an end-user impersonates", async () => {
      const endUser = await seedEndUser({
        spaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        externalId: "ext-eu-pin-del",
      });
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        name: "pin-test-key-del",
        scopes: ["integrations:connect"],
      });

      const res = await deletePin({
        Authorization: `Bearer ${apiKey.rawKey}`,
        "X-Space-Id": ctx.defaultSpaceId,
        "Appstrate-User": endUser.id,
      });

      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("forbidden");
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
    const deletePath = `/api/me/integration-pins/${AGENT}/integrations/${INTEGRATION}`;

    async function keyHeaders(scopes: string[]): Promise<Record<string, string>> {
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes,
      });
      return { Authorization: `Bearer ${apiKey.rawKey}`, "X-Space-Id": ctx.defaultSpaceId };
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
      const res = await putPin([connectionId], await keyHeaders(["integrations:read"]));
      expect(res.status).toBe(403);
      expect(await pinnedConnections()).toEqual([]);
    });

    it("PUT: a key with integrations:connect pins", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      const res = await putPin([connectionId], await keyHeaders(["integrations:connect"]));
      expect(res.status).toBe(200);
      expect(await pinnedConnections()).toEqual([connectionId]);
    });

    it("PUT: a cookie session, which carries no ceiling, pins", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      expect((await putPin([connectionId])).status).toBe(200);
      expect(await pinnedConnections()).toEqual([connectionId]);
    });

    it("DELETE: a key without integrations:connect is refused and the pin survives", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      expect((await putPin([connectionId])).status).toBe(200);
      const headers = await keyHeaders(["integrations:read", "integrations:disconnect"]);
      const res = await app.request(deletePath, { method: "DELETE", headers });
      expect(res.status).toBe(403);
      expect(await pinnedConnections()).toEqual([connectionId]);
    });

    it("DELETE: a key with integrations:connect clears the pin", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      expect((await putPin([connectionId])).status).toBe(200);
      const headers = await keyHeaders(["integrations:connect"]);
      const res = await app.request(deletePath, { method: "DELETE", headers });
      expect(res.status).toBe(204);
      expect(await pinnedConnections()).toEqual([]);
    });

    it("DELETE: a cookie session, which carries no ceiling, clears the pin", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      expect((await putPin([connectionId])).status).toBe(200);
      const res = await app.request(deletePath, { method: "DELETE", headers: authHeaders(ctx) });
      expect(res.status).toBe(204);
      expect(await pinnedConnections()).toEqual([]);
    });

    it("GET: a key without integrations:read is refused", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      expect((await putPin([connectionId])).status).toBe(200);
      const headers = await keyHeaders(["integrations:connect"]);
      expect((await app.request(listPath, { headers })).status).toBe(403);
    });

    it("GET: a key with integrations:read lists the pin", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id);
      expect((await putPin([connectionId])).status).toBe(200);
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

    async function pinSet(connectionIds: string[], agent = AGENT) {
      expect((await putPin(connectionIds, authHeaders(ctx), agent)).status).toBe(200);
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

    function readPins() {
      return db
        .select({
          id: integrationPins.id,
          agent: integrationPins.packageId,
          integration: integrationPins.integrationId,
          connectionIds: integrationPins.connectionIds,
          updatedAt: integrationPins.updatedAt,
        })
        .from(integrationPins);
    }

    function readSchedules() {
      return db
        .select({
          id: schedules.id,
          userId: schedules.userId,
          enabled: schedules.enabled,
          connectionOverrides: schedules.connectionOverrides,
          nextRunAt: schedules.nextRunAt,
          updatedAt: schedules.updatedAt,
        })
        .from(schedules);
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
      await pinSet([web!, db2!]);
      await pinSet([db2!], OTHER_AGENT);
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
        other_schedules_disabled_count: 0,
      });
      // A connection nothing names lists nothing.
      expect(await impactOf(spare!)).toEqual({
        pins: [],
        schedules: [],
        other_schedules_disabled_count: 0,
      });
    });

    it("announces exactly the rewrites the delete then makes, read back from the rows", async () => {
      const [web, gone] = [
        await seedConnectionFor(ctx.user.id),
        await seedConnectionFor(ctx.user.id),
      ];
      const owner = { userId: ctx.user.id };
      await pinSet([gone!]);
      await pinSet([web!, gone!], OTHER_AGENT);
      const alone = await scheduleFor([gone!], owner, "alone");
      await db
        .update(schedules)
        .set({ nextRunAt: new Date(Date.now() + 3_600_000) })
        .where(eq(schedules.id, alone.id));
      const several = await scheduleFor([web!, gone!], owner, "several");
      await scheduleFor([gone!], owner, "off", false);
      const unknown = crypto.randomUUID();
      await seedSchedule({
        packageId: AGENT,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        name: "two integrations",
        enabled: true,
        ...owner,
        connectionOverrides: {
          [INTEGRATION]: [gone!],
          "@pinorg/other-svc": [unknown],
        },
      });
      // An explicit `[]` beside a set that only shrinks: the delete keeps it and the schedule armed.
      const emptySibling = await seedSchedule({
        packageId: AGENT,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        name: "empty sibling",
        enabled: true,
        ...owner,
        connectionOverrides: { [INTEGRATION]: [gone!, web!], "@pinorg/other-svc": [] },
      });
      const colleague = await createTestUser();
      await addOrgMember(ctx.orgId, colleague.id);
      const colleagues = await scheduleFor([gone!], { userId: colleague.id }, "colleague");

      const [pinsBefore, schedulesBefore] = [await readPins(), await readSchedules()];
      const announced = await impactOf(gone!);
      // An id no connection carries previews nothing, though one of the caller's schedules names it.
      expect(await impactOf(unknown)).toEqual({
        pins: [],
        schedules: [],
        other_schedules_disabled_count: 0,
      });

      const del = await app.request(`/api/me/connections/${gone}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(del.status).toBe(204);
      const pinsAfter = new Map((await readPins()).map((p) => [p.id, p]));
      const schedulesAfter = new Map((await readSchedules()).map((s) => [s.id, s]));

      const sortedBy = <T>(rows: T[], key: (row: T) => string) =>
        [...rows].sort((a, b) => key(a).localeCompare(key(b)));
      const rewrittenPins = pinsBefore
        .filter((before) => !Bun.deepEquals(pinsAfter.get(before.id), before))
        .map((before) => ({
          agent_package_id: before.agent,
          integration_package_id: before.integration,
          connection_count: before.connectionIds.length,
        }));
      // The preview lists the owner's schedules and counts the others'.
      const rewrittenSchedules = schedulesBefore.flatMap((before) => {
        const after = schedulesAfter.get(before.id)!;
        if (before.userId !== ctx.user.id || Bun.deepEquals(after, before)) return [];
        return Object.entries(before.connectionOverrides ?? {})
          .filter(([, ids]) => ids.includes(gone!))
          .map(([id, ids]) => ({
            scheduleId: before.id,
            integration_package_id: id,
            connection_count: ids.length,
            disables: before.enabled && !after.enabled,
          }));
      });
      // Not vacuous: both pins, and one entry per schedule of the owner's naming the connection.
      expect(announced.pins).toHaveLength(2);
      expect(announced.schedules).toHaveLength(5);
      expect(
        sortedBy(
          announced.pins.map(({ agent_display_name: _name, ...pin }) => pin),
          (p) => p.agent_package_id,
        ),
      ).toEqual(sortedBy(rewrittenPins, (p) => p.agent_package_id));
      expect(
        sortedBy(
          announced.schedules.map(
            ({ scheduleId, integration_package_id, connection_count, disables }) => ({
              scheduleId,
              integration_package_id,
              connection_count,
              disables,
            }),
          ),
          (s) => s.scheduleId + s.integration_package_id,
        ),
      ).toEqual(sortedBy(rewrittenSchedules, (s) => s.scheduleId + s.integration_package_id));

      // The ids the delete reports disabled are the ones the preview said it would: the owner's it
      // lists, and the colleague's it counts, disabled with its overrides kept.
      const [audit] = await db
        .select({ after: auditEvents.after })
        .from(auditEvents)
        .where(eq(auditEvents.action, "integration.connection.deleted"));
      const { disabledScheduleIds } = audit!.after as { disabledScheduleIds: string[] };
      const listed = new Set(
        announced.schedules.filter((s) => s.disables).map((s) => s.scheduleId),
      );
      const counted = disabledScheduleIds.filter((id) => !listed.has(id));
      expect(disabledScheduleIds.filter((id) => listed.has(id)).sort()).toEqual([...listed].sort());
      expect(counted).toEqual([colleagues.id]);
      expect(announced.other_schedules_disabled_count).toBe(counted.length);
      expect(schedulesAfter.get(colleagues.id)).toMatchObject({
        connectionOverrides: { [INTEGRATION]: [gone!] },
        enabled: false,
      });

      // A set that only shrinks stays armed; an emptied one disables its schedule instead of
      // letting it fall back to another account unattended.
      expect(schedulesAfter.get(several.id)).toMatchObject({
        connectionOverrides: { [INTEGRATION]: [web!] },
        enabled: true,
      });
      expect(schedulesAfter.get(alone.id)).toMatchObject({
        connectionOverrides: null,
        enabled: false,
        nextRunAt: null,
      });
      expect(schedulesAfter.get(emptySibling.id)).toMatchObject({
        connectionOverrides: { [INTEGRATION]: [web!], "@pinorg/other-svc": [] },
        enabled: true,
      });
    });

    // Only an explicit write pins to none: a set the delete empties drops its pin, and a pin to
    // none, naming nothing, is left alone.
    it("drops the pin a delete empties and keeps a pin to none", async () => {
      const gone = await seedConnectionFor(ctx.user.id);
      await pinSet([]);
      await pinSet([gone], OTHER_AGENT);

      const announced = await impactOf(gone);
      expect(announced.pins.map((p) => p.agent_package_id)).toEqual([OTHER_AGENT]);

      const del = await app.request(`/api/me/connections/${gone}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(del.status).toBe(204);
      expect((await readPins()).map((p) => [p.agent, p.connectionIds])).toEqual([[AGENT, []]]);
    });

    it("is empty for a colleague's shared connection the caller pinned and scheduled, which the delete refuses", async () => {
      const colleague = await createTestUser();
      await addOrgMember(ctx.orgId, colleague.id);
      const shared = await seedConnectionFor(colleague.id, { shared: true });
      await pinSet([shared]);
      await scheduleFor([shared], { userId: ctx.user.id });
      const [pinsBefore, schedulesBefore] = [await readPins(), await readSchedules()];

      expect(await impactOf(shared)).toEqual({
        pins: [],
        schedules: [],
        other_schedules_disabled_count: 0,
      });
      const del = await app.request(`/api/me/connections/${shared}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      // Same 204 as an unknown id: a probe learns nothing, and the row is untouched.
      expect(del.status).toBe(204);
      expect(await readPins()).toEqual(pinsBefore);
      expect(await readSchedules()).toEqual(schedulesBefore);
    });

    it("counts, for a key bound to one space, only the other people's schedules of that space", async () => {
      const spaceB = await seedSpace({ orgId: ctx.orgId, name: "B" });
      const shared = await seedConnectionFor(ctx.user.id, { shared: true });
      const colleague = await createTestUser();
      await addOrgMember(ctx.orgId, colleague.id);
      await scheduleFor([shared], { userId: colleague.id }, "in the key's space");
      // Enabled in another space, which no write check prevents on a re-enable.
      await seedSchedule({
        packageId: AGENT,
        orgId: ctx.orgId,
        spaceId: spaceB.id,
        name: "elsewhere",
        enabled: true,
        userId: colleague.id,
        connectionOverrides: { [INTEGRATION]: [shared] },
      });
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["integrations:read", "integrations:disconnect"],
      });
      const keyHeaders = {
        Authorization: `Bearer ${apiKey.rawKey}`,
        "X-Space-Id": ctx.defaultSpaceId,
      };

      expect((await impactOf(shared, keyHeaders)).other_schedules_disabled_count).toBe(1);
      // Unbound, the same caller counts both: the narrower count is the binding's.
      expect((await impactOf(shared)).other_schedules_disabled_count).toBe(2);
    });

    it("is empty for a key bound to one space on the creator's connection of another", async () => {
      const spaceB = await seedSpace({ orgId: ctx.orgId, name: "B" });
      const elsewhere = await seedConnectionFor(ctx.user.id, { spaceId: spaceB.id });
      // A disabled schedule of the creator's own in the key's space names it: no reach check
      // guards a self write to a disabled schedule.
      const inKeySpace = await scheduleFor([elsewhere], { userId: ctx.user.id }, null, false);
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["integrations:read", "integrations:disconnect"],
      });
      const keyHeaders = {
        Authorization: `Bearer ${apiKey.rawKey}`,
        "X-Space-Id": ctx.defaultSpaceId,
      };

      expect(await impactOf(elsewhere, keyHeaders)).toEqual({
        pins: [],
        schedules: [],
        other_schedules_disabled_count: 0,
      });
      // Unbound, the same caller sees the schedule: the empty answer is the binding's.
      expect((await impactOf(elsewhere)).schedules.map((s) => s.scheduleId)).toEqual([
        inKeySpace.id,
      ]);
      // The key's delete is refused by its binding too, not by its ceiling: a 204 that writes nothing.
      const schedulesBefore = await readSchedules();
      const del = await app.request(`/api/me/connections/${elsewhere}`, {
        method: "DELETE",
        headers: keyHeaders,
      });
      expect(del.status).toBe(204);
      expect(await readSchedules()).toEqual(schedulesBefore);
      const kept = await db
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, elsewhere));
      expect(kept).toHaveLength(1);
    });

    it("hides from a key bound to the connection's space the creator's schedule of another space", async () => {
      const spaceB = await seedSpace({ orgId: ctx.orgId, name: "B" });
      const connectionId = await seedConnectionFor(ctx.user.id);
      // A disabled schedule of the creator's own in space B names it: no reach check guards a
      // self write to a disabled schedule.
      const inOtherSpace = await seedSchedule({
        packageId: AGENT,
        orgId: ctx.orgId,
        spaceId: spaceB.id,
        name: "space B",
        enabled: false,
        userId: ctx.user.id,
        connectionOverrides: { [INTEGRATION]: [connectionId] },
      });
      const inKeySpace = await scheduleFor([connectionId], { userId: ctx.user.id });
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["integrations:read"],
      });

      const bound = await impactOf(connectionId, {
        Authorization: `Bearer ${apiKey.rawKey}`,
        "X-Space-Id": ctx.defaultSpaceId,
      });
      expect(bound.schedules.map((s) => s.scheduleId)).toEqual([inKeySpace.id]);
      // Unbound, the same caller sees both.
      expect((await impactOf(connectionId)).schedules.map((s) => s.scheduleId).sort()).toEqual(
        [inKeySpace.id, inOtherSpace.id].sort(),
      );
    });

    it("lists a connection an admin pinned, whose delete answers 409 connection_pinned", async () => {
      const connectionId = await seedConnectionFor(ctx.user.id, { shared: true });
      await db.insert(integrationPins).values({
        spaceId: ctx.defaultSpaceId,
        packageId: AGENT,
        integrationId: INTEGRATION,
        userId: null,
        createdBy: ctx.user.id,
        connectionIds: [connectionId],
      });
      const schedule = await scheduleFor([connectionId], { userId: ctx.user.id });

      expect((await impactOf(connectionId)).schedules.map((s) => s.scheduleId)).toEqual([
        schedule.id,
      ]);
      const del = await app.request(`/api/me/connections/${connectionId}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(del.status).toBe(409);
      expect(((await del.json()) as { code: string }).code).toBe("connection_pinned");
    });

    it("lists a key bound to a space only the pins of that space", async () => {
      const spaceB = await seedSpace({ orgId: ctx.orgId, name: "Bravo" });
      const [row] = await db
        .insert(integrationConnections)
        .values({
          integrationId: INTEGRATION,
          authKey: "primary",
          accountId: "acct-org",
          orgId: ctx.orgId,
          spaceId: null,
          originSpaceId: spaceB.id,
          userId: ctx.user.id,
          credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret" } }),
          scopesGranted: [],
          label: "Org row",
        })
        .returning({ id: integrationConnections.id });
      await db.insert(integrationPins).values(
        [ctx.defaultSpaceId, spaceB.id].map((spaceId) => ({
          spaceId,
          packageId: AGENT,
          integrationId: INTEGRATION,
          userId: ctx.user.id,
          connectionIds: [row!.id],
        })),
      );
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["integrations:read"],
      });

      expect((await impactOf(row!.id)).pins).toHaveLength(2);
      const bound = await impactOf(row!.id, { Authorization: `Bearer ${apiKey.rawKey}` });
      expect(bound.pins).toHaveLength(1);
    });

    it("is empty for an id that is not a UUID", async () => {
      expect(await impactOf("not-a-uuid")).toEqual({
        pins: [],
        schedules: [],
        other_schedules_disabled_count: 0,
      });
    });

    it("gives an end user previewing its own connection only its own schedules", async () => {
      const endUser = await seedEndUser({
        spaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        externalId: "ext-eu-delete-impact",
      });
      const connectionId = await seedConnectionFor(null, { endUserId: endUser.id });
      const own = await scheduleFor([connectionId], { endUserId: endUser.id });
      await scheduleFor([connectionId], { userId: ctx.user.id });
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
      expect(impact.schedules.map((s) => s.scheduleId)).toEqual([own.id]);
    });
  });
});
