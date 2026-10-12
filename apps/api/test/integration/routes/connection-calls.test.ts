// SPDX-License-Identifier: Apache-2.0

/**
 * The two reads of the credential proxy's call journal.
 *
 *   - `GET /api/me/connections/{connectionId}/calls`: the owner reads every call made with their
 *     connection, whoever made it; anyone else gets a 404; a delegated credential is capped by
 *     `integrations:read` and confined to its binding.
 *   - `GET /api/integrations/calls`: a holder of `integrations:configure` reads every call made in
 *     the request space, and never another space's or another organization's.
 *
 * Both take the same filters, keyset pagination and `?format=csv`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { connectionCalls, integrationConnections } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedEndUser, seedPackage, seedSpace } from "../../helpers/seed.ts";
import { walkLinkPages } from "../../helpers/pagination.ts";
import { recordConnectionCall } from "../../../src/services/credential-proxy/call-journal.ts";
import {
  connectionCallsCsv,
  type ConnectionCallView,
} from "../../../src/services/connection-calls.ts";

const app = getTestApp();

const CRM = "@calls/crm";
const MAIL = "@calls/mail";
const SPACE_DOOR = "/api/integrations/calls";

interface Page {
  object: "list";
  data: ConnectionCallView[];
  hasMore: boolean;
}

describe("connection call journal routes", () => {
  /** The org owner: holds `integrations:configure` in every team space. */
  let ctx: TestContext;
  /** A plain member: `operator` in the open default space, so no `configure`. */
  let colleague: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "calls" });
    colleague = await memberContext(ctx, "member");
    for (const id of [CRM, MAIL]) {
      await seedPackage({ id, orgId: ctx.orgId, type: "integration", source: "local" });
    }
  });

  /** A connection of the member `owner`, or of an end-user. */
  async function seedConnection(
    owner: string | { endUserId: string },
    integrationId = CRM,
  ): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId,
        authKey: "primary",
        accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
        label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: typeof owner === "string" ? owner : null,
        endUserId: typeof owner === "string" ? null : owner.endUserId,
        credentialsEncrypted: "x",
        scopesGranted: [],
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  /** Journal one call made by the owner in the default space, unless `overrides` say otherwise. */
  async function record(
    connectionId: string,
    overrides: Partial<Parameters<typeof recordConnectionCall>[0]> = {},
  ): Promise<void> {
    await recordConnectionCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      connectionId,
      integrationId: CRM,
      actor: { type: "user", id: ctx.user.id },
      apiKeyId: null,
      authMethod: "session",
      runId: null,
      method: "GET",
      target: "https://api.example.com/v1/users?page=2",
      outcome: "200",
      durationMs: 12,
      requestId: null,
      ...overrides,
    });
  }

  async function page(path: string, headers: Record<string, string> = authHeaders(ctx)) {
    const res = await app.request(path, { headers });
    expect(res.status).toBe(200);
    return (await res.json()) as Page;
  }

  const ownDoor = (connectionId: string) => `/api/me/connections/${connectionId}/calls`;

  // ─── Owner door ─────────────────────────────────────────

  describe("GET /api/me/connections/:connectionId/calls", () => {
    it("lists every call made with the caller's connection, whoever made it, newest first", async () => {
      const connectionId = await seedConnection(ctx.user.id);
      await record(connectionId);
      await record(connectionId, {
        actor: { type: "user", id: colleague.user.id },
        apiKeyId: "key_1",
        authMethod: "api_key",
        runId: "run_1",
        method: "POST",
        outcome: "unauthorized_target",
        requestId: "req_2",
      });

      const body = await page(ownDoor(connectionId));

      expect(body.hasMore).toBe(false);
      expect(body.data.map((call) => call.actor_id)).toEqual([colleague.user.id, ctx.user.id]);
      expect(body.data[0]).toEqual({
        id: expect.any(Number),
        createdAt: expect.any(String),
        spaceId: ctx.defaultSpaceId,
        connection_id: connectionId,
        integration_package_id: CRM,
        owner_type: "user",
        owner_id: ctx.user.id,
        actor_type: "user",
        actor_id: colleague.user.id,
        apiKeyId: "key_1",
        auth_method: "api_key",
        runId: "run_1",
        method: "POST",
        host: "api.example.com",
        path: "/v1/users",
        outcome: "unauthorized_target",
        duration_ms: 12,
        request_id: "req_2",
      });
    });

    it("lists the calls made from every space, and none of another connection", async () => {
      const elsewhere = await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" });
      const connectionId = await seedConnection(ctx.user.id);
      const otherConnectionId = await seedConnection(ctx.user.id);
      await record(connectionId);
      await record(connectionId, { spaceId: elsewhere.id });
      await record(otherConnectionId);

      const body = await page(ownDoor(connectionId));

      expect(body.data.map((call) => call.spaceId)).toEqual([elsewhere.id, ctx.defaultSpaceId]);
      expect(new Set(body.data.map((call) => call.connection_id))).toEqual(new Set([connectionId]));
    });

    it("404s a connection the caller does not own, though they made calls with it", async () => {
      const connectionId = await seedConnection(ctx.user.id);
      await record(connectionId, { actor: { type: "user", id: colleague.user.id } });

      const res = await app.request(ownDoor(connectionId), { headers: authHeaders(colleague) });

      expect(res.status).toBe(404);
    });

    it("404s an unknown or malformed connection id", async () => {
      for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
        const res = await app.request(ownDoor(id), { headers: authHeaders(ctx) });
        expect(res.status).toBe(404);
      }
    });

    it("caps a delegated credential with integrations:read and confines it to its space", async () => {
      const elsewhere = await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" });
      const connectionId = await seedConnection(ctx.user.id);
      await record(connectionId);
      await record(connectionId, { spaceId: elsewhere.id });
      const key = (scopes: string[]) =>
        seedApiKey({
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          createdBy: ctx.user.id,
          scopes,
        });

      const reader = await key(["integrations:read"]);
      const body = await page(ownDoor(connectionId), {
        Authorization: `Bearer ${reader.rawKey}`,
      });
      expect(body.data.map((call) => call.spaceId)).toEqual([ctx.defaultSpaceId]);

      const stranger = await key(["agents:read"]);
      const refused = await app.request(ownDoor(connectionId), {
        headers: { Authorization: `Bearer ${stranger.rawKey}` },
      });
      expect(refused.status).toBe(403);
    });

    it("under Appstrate-User, reads the end-user's own connections only", async () => {
      const endUser = await seedEndUser({ spaceId: ctx.defaultSpaceId, orgId: ctx.orgId });
      const theirs = await seedConnection({ endUserId: endUser.id });
      const creators = await seedConnection(ctx.user.id);
      await record(theirs, { actor: { type: "end_user", id: endUser.id }, requestId: "req_eu" });
      await record(creators, { requestId: "req_creator" });
      const key = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["integrations:read"],
      });
      const asKey = { Authorization: `Bearer ${key.rawKey}` };
      const asEndUser = { ...asKey, "Appstrate-User": endUser.id };

      const own = await page(ownDoor(theirs), asEndUser);
      expect(own.data.map((call) => [call.request_id, call.owner_type, call.owner_id])).toEqual([
        ["req_eu", "end_user", endUser.id],
      ]);
      // The key's creator owns the other connection; the end-user acting through the key does not.
      const refused = await app.request(ownDoor(creators), { headers: asEndUser });
      expect(refused.status).toBe(404);

      // And the reverse: the key alone acts as its creator.
      expect((await page(ownDoor(creators), asKey)).data.map((call) => call.request_id)).toEqual([
        "req_creator",
      ]);
      expect((await app.request(ownDoor(theirs), { headers: asKey })).status).toBe(404);
    });

    it("filters by actor, and refuses the space door's connection filter", async () => {
      const connectionId = await seedConnection(ctx.user.id);
      await record(connectionId);
      await record(connectionId, { actor: { type: "user", id: colleague.user.id } });

      const body = await page(`${ownDoor(connectionId)}?actor_id=${colleague.user.id}`);
      expect(body.data.map((call) => call.actor_id)).toEqual([colleague.user.id]);

      const res = await app.request(`${ownDoor(connectionId)}?connection_id=${connectionId}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(400);
    });

    it("exports the same rows as CSV", async () => {
      const connectionId = await seedConnection(ctx.user.id);
      await record(connectionId);
      await record(connectionId, { method: "DELETE" });

      const json = await page(ownDoor(connectionId));
      const res = await app.request(`${ownDoor(connectionId)}?format=csv`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toStartWith("text/csv");
      expect(await res.text()).toBe(connectionCallsCsv(json.data));
    });
  });

  // ─── Space door ─────────────────────────────────────────

  describe("GET /api/integrations/calls", () => {
    it("requires integrations:configure: a member or a key without it is refused, its holder reads", async () => {
      const member = await app.request(SPACE_DOOR, { headers: authHeaders(colleague) });
      expect(member.status).toBe(403);

      // The owner's own key: its creator holds `configure`, its scopes do not.
      const key = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["integrations:read"],
      });
      const viaKey = await app.request(SPACE_DOOR, {
        headers: { Authorization: `Bearer ${key.rawKey}` },
      });
      expect(viaKey.status).toBe(403);

      expect((await page(SPACE_DOOR)).data).toEqual([]);
    });

    it("stays session-only: no key is minted with integrations:configure, even by its holder", async () => {
      const mint = (scopes: string[]) =>
        app.request("/api/api-keys", {
          method: "POST",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({ name: "journal reader", scopes }),
        });

      expect((await mint(["integrations:configure"])).status).toBe(400);
      // The control: the same request with a grantable scope mints a key.
      expect((await mint(["integrations:read"])).status).toBe(201);
    });

    it("lists the space's calls whatever the connection and its owner", async () => {
      const mine = await seedConnection(ctx.user.id);
      const theirs = await seedConnection(colleague.user.id);
      await record(mine);
      await record(theirs, { actor: { type: "user", id: colleague.user.id } });

      const body = await page(SPACE_DOOR);

      expect(body.data.map((call) => [call.connection_id, call.owner_id])).toEqual([
        [theirs, colleague.user.id],
        [mine, ctx.user.id],
      ]);
    });

    it("never lists another space's calls, nor another organization's", async () => {
      const elsewhere = await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" });
      const outside = await createTestContext({ orgSlug: "outside" });
      const connectionId = await seedConnection(ctx.user.id);
      await record(connectionId, { requestId: "req_here" });
      await record(connectionId, { spaceId: elsewhere.id, requestId: "req_elsewhere" });
      await record(crypto.randomUUID(), {
        orgId: outside.orgId,
        spaceId: outside.defaultSpaceId,
        requestId: "req_outside",
      });

      const requestIds = async (headers: Record<string, string>) =>
        (await page(SPACE_DOOR, headers)).data.map((call) => call.request_id);

      expect(await requestIds(authHeaders(ctx))).toEqual(["req_here"]);
      expect(await requestIds(authHeaders(ctx, { "X-Space-Id": elsewhere.id }))).toEqual([
        "req_elsewhere",
      ]);
      expect(await requestIds(authHeaders(outside))).toEqual(["req_outside"]);
    });

    it("filters by connection, integration, actor, run and date", async () => {
      const crm = await seedConnection(ctx.user.id);
      const mail = await seedConnection(colleague.user.id, MAIL);
      await record(crm, { requestId: "req_old" });
      await record(crm, { requestId: "req_run", runId: "run_7" });
      await record(mail, {
        requestId: "req_mail",
        integrationId: MAIL,
        actor: { type: "user", id: colleague.user.id },
      });
      await record(mail, {
        requestId: "req_end_user",
        integrationId: MAIL,
        actor: { type: "end_user", id: "eu_1" },
      });
      await db
        .update(connectionCalls)
        .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
        .where(eq(connectionCalls.requestId, "req_old"));

      const matching = async (query: string) =>
        (await page(`${SPACE_DOOR}?${query}`)).data.map((call) => call.request_id);

      expect(await matching(`connection_id=${crm}`)).toEqual(["req_run", "req_old"]);
      expect(await matching(`integration_package_id=${encodeURIComponent(MAIL)}`)).toEqual([
        "req_end_user",
        "req_mail",
      ]);
      expect(await matching(`actor_id=${colleague.user.id}`)).toEqual(["req_mail"]);
      expect(await matching("actor_type=end_user")).toEqual(["req_end_user"]);
      expect(await matching("runId=run_7")).toEqual(["req_run"]);
      expect(await matching("end_date=2026-06-01T00:00:00Z")).toEqual(["req_old"]);
      expect(await matching("start_date=2026-06-01T00:00:00Z")).toEqual([
        "req_end_user",
        "req_mail",
        "req_run",
      ]);
      expect(await matching(`connection_id=${mail}&actor_type=user`)).toEqual(["req_mail"]);
    });

    it("400s an unknown filter or a malformed value instead of widening the list", async () => {
      for (const query of [
        "actor=me",
        "connection_id=nope",
        "actor_type=robot",
        "start_date=yesterday",
        "startingAfter=abc",
        "format=xml",
        "limit=0",
        "limit=201",
      ]) {
        const res = await app.request(`${SPACE_DOOR}?${query}`, { headers: authHeaders(ctx) });
        expect([query, res.status]).toEqual([query, 400]);
      }
    });

    it("pages newest first on the row id, following the Link header", async () => {
      const connectionId = await seedConnection(ctx.user.id);
      for (let i = 0; i < 5; i++) await record(connectionId, { requestId: `req_${i}` });

      const pages = await walkLinkPages<Page>(app, `${SPACE_DOOR}?limit=2`, authHeaders(ctx));

      expect(pages.map((p) => [p.data.length, p.hasMore])).toEqual([
        [2, true],
        [2, true],
        [1, false],
      ]);
      expect(pages.flatMap((p) => p.data.map((call) => call.request_id))).toEqual([
        "req_4",
        "req_3",
        "req_2",
        "req_1",
        "req_0",
      ]);
    });

    it("exports a page as CSV, with the same filters and the same Link header", async () => {
      const crm = await seedConnection(ctx.user.id);
      const mail = await seedConnection(ctx.user.id, MAIL);
      for (let i = 0; i < 3; i++) await record(crm);
      await record(mail, { integrationId: MAIL });

      const query = `connection_id=${crm}&limit=2`;
      const json = await page(`${SPACE_DOOR}?${query}`);
      const res = await app.request(`${SPACE_DOOR}?${query}&format=csv`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toStartWith("text/csv");
      expect(res.headers.get("Content-Disposition")).toContain("attachment");
      expect(res.headers.get("Link")).toContain(`startingAfter=${json.data[1]!.id}`);
      expect(res.headers.get("Link")).toContain("format=csv");
      const csv = await res.text();
      expect(csv).toBe(connectionCallsCsv(json.data));
      expect(csv.trimEnd().split("\r\n")).toHaveLength(3);
    });

    it("lifts the page size to 10000 rows for a CSV export", async () => {
      const res = await app.request(`${SPACE_DOOR}?format=csv&limit=10000`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const over = await app.request(`${SPACE_DOOR}?format=csv&limit=10001`, {
        headers: authHeaders(ctx),
      });
      expect(over.status).toBe(400);
    });
  });
});
