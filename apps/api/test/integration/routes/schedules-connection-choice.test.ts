// SPDX-License-Identifier: Apache-2.0

/**
 * An armed schedule must fire without asking which connection to use: a write
 * that leaves a `must_choose_connection` open for the schedule's actor, or
 * freezes a pick that actor cannot reach (`override_connection_unavailable`) or
 * that an admin pin or enforced org default outranks (`override_outranked`), is a `409 missing_integration_connection` carrying only those items. Every
 * other connection verdict is accepted — it is repaired without editing the
 * schedule — and a non-required integration a fire would start without is
 * named in the write's `warnings`, to a caller writing for itself: one writing
 * for another member gets none, the actor's connections being theirs to manage.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  integrationConnections,
  integrationOrgDefaults,
  integrationPins,
  schedules,
} from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedEndUser, seedPackage, seedPackageVersion, seedSchedule } from "../../helpers/seed.ts";
import { seedDivergedAgent, seedSchedulableAgent } from "../../helpers/schedule-fixtures.ts";
import {
  seedConnectionTestIntegration,
  seedIntegrationConnection,
} from "../../helpers/run-connection-fixtures.ts";
import { twoAuthApiIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { getSchedule, updateSchedule } from "../../../src/services/scheduler.ts";

const app = getTestApp();

const AGENT = "@schedchoice/agent";
const INTEGRATION = "@schedchoice/svc";

function agentManifest(integrations: boolean): Record<string, unknown> {
  return {
    name: AGENT,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.2",
    display_name: "Schedule Choice Agent",
    ...(integrations
      ? {
          dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
          integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
        }
      : {}),
  };
}

interface WriteBody {
  id: string;
  warnings: { field: string; code: string; candidate_connections?: { id: string }[] }[];
}

interface ProblemBody {
  code: string;
  errors: {
    field: string;
    code: string;
    message: string;
    connection_id?: string;
    candidate_connections?: { id: string }[];
  }[];
}

/** A `409 missing_integration_connection` carrying exactly `codes`, one item per integration. */
async function expectRefusal(res: Response, codes: string[]): Promise<ProblemBody> {
  expect(res.status).toBe(409);
  const body = (await res.json()) as ProblemBody;
  expect(body.code).toBe("missing_integration_connection");
  expect(body.errors.map((e) => e.code)).toEqual(codes);
  return body;
}

describe("schedule writes — the connection choice is made up front", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "schedchoice" });
    await seedConnectionTestIntegration(ctx, INTEGRATION);
  });

  async function seedAgentWithIntegration(): Promise<void> {
    await seedSchedulableAgent({
      id: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      manifest: agentManifest(true),
    });
  }

  function create(body: Record<string, unknown>) {
    return app.request(`/api/agents/${AGENT}/schedules`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expression: "0 9 * * *", ...body }),
    });
  }

  function patch(id: string, body: Record<string, unknown>) {
    return app.request(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function seedArmedSchedule(connectionOverrides: Record<string, string[]> | null = null) {
    return seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      enabled: true,
      connectionOverrides,
    });
  }

  it("refuses a create whose actor holds two connections and names none", async () => {
    await seedAgentWithIntegration();
    const a = await seedIntegrationConnection(ctx, INTEGRATION);
    const b = await seedIntegrationConnection(ctx, INTEGRATION);

    const res = await create({});
    expect(res.status).toBe(409);
    const body = (await res.json()) as ProblemBody;
    expect(body.code).toBe("missing_integration_connection");
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.field).toBe(`integrations.${INTEGRATION}`);
    expect(body.errors[0]!.code).toBe("must_choose_connection");
    expect(body.errors[0]!.candidate_connections!.map((c) => c.id).sort()).toEqual([a, b].sort());
    expect(await db.select().from(schedules)).toHaveLength(0);
  });

  it("accepts the same create once connection_overrides names one", async () => {
    await seedAgentWithIntegration();
    const picked = await seedIntegrationConnection(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);

    const res = await create({ connection_overrides: { [INTEGRATION]: [picked] } });
    expect(res.status).toBe(201);
  });

  it("accepts a create whose integration is not connected at all, warning that fires start without it", async () => {
    // Connecting later fixes it without editing the schedule.
    await seedAgentWithIntegration();

    const res = await create({});
    expect(res.status).toBe(201);
    const body = (await res.json()) as WriteBody;
    expect(body.warnings.map((w) => [w.field, w.code])).toEqual([
      [`integrations.${INTEGRATION}`, "not_connected"],
    ]);
  });

  it("warns on a patch of an armed schedule, and not once it is disabled", async () => {
    await seedAgentWithIntegration();
    const schedule = await seedArmedSchedule();

    const armed = await patch(schedule.id, { name: "Renamed" });
    expect(armed.status).toBe(200);
    expect(((await armed.json()) as WriteBody).warnings.map((w) => w.code)).toEqual([
      "not_connected",
    ]);

    const disabled = await patch(schedule.id, { enabled: false });
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as WriteBody).warnings).toEqual([]);
  });

  it("warns of nothing once a connection binds", async () => {
    await seedAgentWithIntegration();
    await seedIntegrationConnection(ctx, INTEGRATION);

    const res = await create({});
    expect(res.status).toBe(201);
    expect(((await res.json()) as WriteBody).warnings).toEqual([]);
  });

  it("does not judge a patch that disables the schedule", async () => {
    await seedAgentWithIntegration();
    await seedIntegrationConnection(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);
    const schedule = await seedArmedSchedule();

    const res = await patch(schedule.id, { enabled: false });
    expect(res.status).toBe(200);
  });

  it("refuses re-enabling a disabled schedule that leaves the choice open", async () => {
    await seedAgentWithIntegration();
    await seedIntegrationConnection(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);
    const schedule = await seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      enabled: false,
    });

    await expectRefusal(await patch(schedule.id, { enabled: true }), ["must_choose_connection"]);
  });

  it("refuses any patch of an armed schedule whose resolution became ambiguous", async () => {
    await seedAgentWithIntegration();
    const first = await seedIntegrationConnection(ctx, INTEGRATION);
    const created = await create({});
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    // A second connection since the last save: the fallback no longer decides.
    await seedIntegrationConnection(ctx, INTEGRATION);

    const refused = await patch(id, { name: "renamed" });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as ProblemBody;
    expect(body.errors.map((e) => e.code)).toEqual(["must_choose_connection"]);

    const repaired = await patch(id, {
      name: "renamed",
      connection_overrides: { [INTEGRATION]: [first] },
    });
    expect(repaired.status).toBe(200);
  });

  it("refuses a create whose connection_overrides names a connection the actor cannot reach", async () => {
    await seedAgentWithIntegration();
    await seedIntegrationConnection(ctx, INTEGRATION);

    const res = await create({ connection_overrides: { [INTEGRATION]: [crypto.randomUUID()] } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ProblemBody;
    expect(body.errors.map((e) => [e.field, e.code])).toEqual([
      [`integrations.${INTEGRATION}`, "override_connection_unavailable"],
    ]);
    expect(await db.select().from(schedules)).toHaveLength(0);
  });

  it("refuses any patch of an armed schedule whose frozen pick became unreachable", async () => {
    // Only a new pick repairs it — nothing outside the schedule can.
    await seedAgentWithIntegration();
    const kept = await seedIntegrationConnection(ctx, INTEGRATION);
    const schedule = await seedArmedSchedule({ [INTEGRATION]: [crypto.randomUUID()] });

    const refused = await patch(schedule.id, { name: "renamed" });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as ProblemBody;
    expect(body.errors.map((e) => e.code)).toEqual(["override_connection_unavailable"]);

    const repaired = await patch(schedule.id, {
      name: "renamed",
      connection_overrides: { [INTEGRATION]: [kept] },
    });
    expect(repaired.status).toBe(200);
  });

  it("refuses any patch of an armed schedule that binds none of an integration the agent now requires", async () => {
    await seedSchedulableAgent({
      id: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      manifest: {
        ...agentManifest(true),
        integrations_configuration: { [INTEGRATION]: { tools: ["search"], required: true } },
      },
    });
    const kept = await seedIntegrationConnection(ctx, INTEGRATION);
    const schedule = await seedArmedSchedule({ [INTEGRATION]: [] });

    await expectRefusal(await patch(schedule.id, { name: "renamed" }), [
      "required_integration_unbound",
    ]);
    const repaired = await patch(schedule.id, {
      name: "renamed",
      connection_overrides: { [INTEGRATION]: [kept] },
    });
    expect(repaired.status).toBe(200);
  });

  for (const governance of ["admin pin", "enforced org default"] as const) {
    it(`refuses an override outside an ${governance} (override_outranked), writing nothing`, async () => {
      await seedAgentWithIntegration();
      const governed = await seedIntegrationConnection(ctx, INTEGRATION);
      const outside = await seedIntegrationConnection(ctx, INTEGRATION);
      if (governance === "admin pin") {
        await db.insert(integrationPins).values({
          spaceId: ctx.defaultSpaceId,
          packageId: AGENT,
          integrationId: INTEGRATION,
          userId: null,
          connectionIds: [governed],
        });
      } else {
        await db.insert(integrationOrgDefaults).values({
          spaceId: ctx.defaultSpaceId,
          integrationId: INTEGRATION,
          connectionIds: [governed],
          enforce: true,
        });
      }

      const res = await create({ connection_overrides: { [INTEGRATION]: [outside] } });
      const body = await expectRefusal(res, ["override_outranked"]);
      expect(body.errors[0]!.field).toBe(`integrations.${INTEGRATION}`);
      expect(await db.select().from(schedules)).toHaveLength(0);
      // Control: an override inside the governing set is accepted.
      const inside = await create({ connection_overrides: { [INTEGRATION]: [governed] } });
      expect(inside.status).toBe(201);
    });
  }

  it("refuses a colleague's real private connection like an unknown id, naming neither label nor account", async () => {
    await seedAgentWithIntegration();
    const colleague = await memberContext(ctx, "member");
    const theirs = await seedIntegrationConnection(colleague, INTEGRATION, {
      label: "colleague-label",
      accountId: "colleague-account",
    });

    const res = await create({ connection_overrides: { [INTEGRATION]: [theirs] } });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).not.toContain("colleague-label");
    expect(text).not.toContain("colleague-account");
    expect((JSON.parse(text) as ProblemBody).errors.map((e) => e.code)).toEqual([
      "override_connection_unavailable",
    ]);
    expect(await db.select().from(schedules)).toHaveLength(0);
  });

  it("judges the definition the schedule fires, not the draft", async () => {
    // Published declares no integration; the draft does.
    await seedDivergedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      published: agentManifest(false),
      draft: agentManifest(true),
    });
    await seedIntegrationConnection(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);

    expect((await create({})).status).toBe(201);
    await expectRefusal(await create({ version_override: "draft" }), ["must_choose_connection"]);

    // A patch moving an armed schedule onto the draft is judged against it too.
    const inherit = (await db.select().from(schedules))[0]!;
    await expectRefusal(await patch(inherit.id, { version_override: "draft" }), [
      "must_choose_connection",
    ]);
    await db.update(schedules).set({ enabled: false }).where(eq(schedules.id, inherit.id));
    expect((await patch(inherit.id, { version_override: "draft" })).status).toBe(200);
  });
});

describe("schedule writes for another actor — only what both reach", () => {
  let ctx: TestContext;
  let member: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "schedchoice" });
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedSchedulableAgent({
      id: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      manifest: agentManifest(true),
    });
    member = await memberContext(ctx, "member");
  });

  /** The owner (caller) writes a schedule that runs as `member`. */
  function createForMember(body: Record<string, unknown> = {}) {
    return app.request(`/api/agents/${AGENT}/schedules`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        cron_expression: "0 9 * * *",
        actor: { userId: member.user.id },
        ...body,
      }),
    });
  }

  async function share(id: string): Promise<void> {
    await db
      .update(integrationConnections)
      .set({ sharedWithOrg: true })
      .where(eq(integrationConnections.id, id));
  }

  it("lists none of the actor's private connections as candidates", async () => {
    await seedIntegrationConnection(member, INTEGRATION);
    await seedIntegrationConnection(member, INTEGRATION);

    const res = await createForMember();
    expect(res.status).toBe(409);
    const body = (await res.json()) as ProblemBody;
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({
      field: `integrations.${INTEGRATION}`,
      code: "must_choose_connection",
      candidate_connections: [],
    });
    expect(body.errors[0]!.message).toContain("actor");
    expect(await db.select().from(schedules)).toHaveLength(0);
  });

  it("refuses overrides naming the actor's private connection, like an unknown id", async () => {
    const own = await seedIntegrationConnection(member, INTEGRATION);
    await seedIntegrationConnection(member, INTEGRATION);

    for (const id of [own, crypto.randomUUID()]) {
      const res = await createForMember({ connection_overrides: { [INTEGRATION]: [id] } });
      expect(res.status).toBe(409);
      const body = (await res.json()) as ProblemBody;
      expect(body.errors.map((e) => e.code)).toEqual(["override_connection_unavailable"]);
      expect(body.errors[0]!.candidate_connections).toBeUndefined();
    }
    expect(await db.select().from(schedules)).toHaveLength(0);
  });

  it("accepts, warning of nothing, when the actor's only reach is a connection someone shared", async () => {
    const shared = await seedIntegrationConnection(ctx, INTEGRATION);
    await share(shared);

    const res = await createForMember();
    expect(res.status).toBe(201);
    expect(((await res.json()) as WriteBody).warnings).toEqual([]);
  });

  it("warns of nothing whether the actor holds no connection or one", async () => {
    const none = await createForMember();
    expect(none.status).toBe(201);
    expect(((await none.json()) as WriteBody).warnings).toEqual([]);

    await seedIntegrationConnection(member, INTEGRATION);
    const one = await createForMember();
    expect(one.status).toBe(201);
    expect(((await one.json()) as WriteBody).warnings).toEqual([]);
  });

  it("offers a shared candidate, and binding it is accepted", async () => {
    await seedIntegrationConnection(member, INTEGRATION);
    await seedIntegrationConnection(member, INTEGRATION);
    const shared = await seedIntegrationConnection(ctx, INTEGRATION);
    await share(shared);

    const refused = await createForMember();
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as ProblemBody;
    expect(body.errors[0]!.candidate_connections!.map((c) => c.id)).toEqual([shared]);

    const res = await createForMember({ connection_overrides: { [INTEGRATION]: [shared] } });
    expect(res.status).toBe(201);
  });

  it("keeps a private pick already on the actor's schedule when another caller edits it", async () => {
    const own = await seedIntegrationConnection(member, INTEGRATION);
    await seedIntegrationConnection(member, INTEGRATION);
    const schedule = await seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: member.user.id,
      enabled: true,
      connectionOverrides: { [INTEGRATION]: [own] },
    });

    const res = await app.request(`/api/schedules/${schedule.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed", connection_overrides: { [INTEGRATION]: [own] } }),
    });
    expect(res.status).toBe(200);
  });

  it("judges a disabled write too — disabling is no way to store a colleague's private pick", async () => {
    const own = await seedIntegrationConnection(member, INTEGRATION);
    await seedIntegrationConnection(member, INTEGRATION);
    const schedule = await seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      enabled: false,
    });
    const patch = (body: Record<string, unknown>) =>
      app.request(`/api/schedules/${schedule.id}`, {
        method: "PATCH",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // Re-point to the member and store their private id while disabled, to arm it next.
    const probe = async (id: string) => {
      const res = await patch({
        enabled: false,
        actor: { userId: member.user.id },
        connection_overrides: { [INTEGRATION]: [id] },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as ProblemBody;
      expect(body.errors.map((e) => e.code)).toEqual(["override_connection_unavailable"]);
      return body.errors[0]!.message.replace(id, "<id>");
    };
    const unknown = crypto.randomUUID();
    // A real private row and a made-up id read the same: nothing to probe.
    expect(await probe(own)).toBe(await probe(unknown));

    const [row] = await db.select().from(schedules).where(eq(schedules.id, schedule.id));
    expect(row).toMatchObject({ userId: ctx.user.id, connectionOverrides: null, enabled: false });
    expect((await patch({ enabled: true })).status).toBe(200);
  });

  // Two PATCHes interleaved: P1 re-points the actor to the member, P2 — read before P1 committed —
  // stores the member's private id, judged as the owner's own pick. P2's write must not land.
  it("refuses a write judged against a row a concurrent write re-pointed, and writes nothing", async () => {
    const own = await seedIntegrationConnection(member, INTEGRATION);
    const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    const seeded = await seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      enabled: false,
    });
    const judged = (await getSchedule(seeded.id, scope, null, undefined))!;
    // P1 commits between P2's read and P2's write, bumping the stamp as every schedule write does.
    await db
      .update(schedules)
      .set({ userId: member.user.id, updatedAt: sql`${schedules.updatedAt} + interval '1 second'` })
      .where(eq(schedules.id, seeded.id));

    await expect(
      updateSchedule(
        scope,
        judged,
        { connectionOverrides: { [INTEGRATION]: [own] }, enabled: true },
        null,
        undefined,
      ),
    ).rejects.toMatchObject({ status: 409, code: "schedule_modified_concurrently" });
    const [row] = await db.select().from(schedules).where(eq(schedules.id, seeded.id));
    expect(row).toMatchObject({
      userId: member.user.id,
      connectionOverrides: null,
      enabled: false,
    });
  });

  it("refuses an actor who cannot run agents in this space before resolving anything", async () => {
    const guest = await memberContext(ctx, "guest");
    await seedIntegrationConnection(guest, INTEGRATION);
    await seedIntegrationConnection(guest, INTEGRATION);

    const res = await app.request(`/api/agents/${AGENT}/schedules`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expression: "0 9 * * *", actor: { userId: guest.user.id } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; param?: string; errors?: unknown };
    expect(body.code).toBe("schedule_actor_invalid");
    expect(body.param).toBe("actor");
    expect(body.errors).toBeUndefined();
    expect(await db.select().from(schedules)).toHaveLength(0);
  });
});

describe("schedule writes — a set on an auth serving no selected tool", () => {
  const API = "@schedchoice/api";
  let ctx: TestContext;
  let backup: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "schedchoice" });
    const manifest = twoAuthApiIntegrationManifest(API);
    await seedPackage({
      id: API,
      orgId: ctx.orgId,
      homeSpaceId: ctx.defaultSpaceId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
    await seedPackageVersion({
      packageId: API,
      version: "1.0.0",
      manifest: manifest as unknown as Record<string, unknown>,
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, API);
    await seedSchedulableAgent({
      id: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      manifest: {
        ...agentManifest(false),
        dependencies: { integrations: { [API]: "^1.0.0" } },
        integrations_configuration: { [API]: { tools: ["api_call__primary"] } },
      },
    });
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: API,
        authKey: "backup",
        accountId: "spare",
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
        scopesGranted: [],
        label: "spare",
      })
      .returning({ id: integrationConnections.id });
    backup = row!.id;
  });

  function create(body: Record<string, unknown>) {
    return app.request(`/api/agents/${AGENT}/schedules`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expression: "0 9 * * *", ...body }),
    });
  }

  it("refuses it when the schedule's own override binds it", async () => {
    const res = await create({ connection_overrides: { [API]: [backup] } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ProblemBody;
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({
      field: `integrations.${API}`,
      code: "auth_serves_no_selected_tool",
      connection_id: backup,
    });
  });

  it("names no label or account of another member's private row the stored set binds", async () => {
    const member = await memberContext(ctx, "member");
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: API,
        authKey: "backup",
        accountId: "private-account",
        spaceId: ctx.defaultSpaceId,
        userId: member.user.id,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
        scopesGranted: [],
        label: "private-label",
      })
      .returning({ id: integrationConnections.id });
    const schedule = await seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: member.user.id,
      enabled: true,
      connectionOverrides: { [API]: [row!.id] },
    });

    // The owner edits the member's schedule; the stored set is exempt, its verdict is not.
    const res = await app.request(`/api/schedules/${schedule.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).not.toContain("private-label");
    expect(text).not.toContain("private-account");
    const body = JSON.parse(text) as ProblemBody;
    // The id is on the schedule the caller reads, so it stays.
    expect(body.errors).toEqual([
      expect.objectContaining({ code: "auth_serves_no_selected_tool", connection_id: row!.id }),
    ]);
  });

  it("names the auths the actor's rows use in a warning to the actor, and warns no one else", async () => {
    const KEYED = "@schedchoice/keyed-agent";
    await seedSchedulableAgent({
      id: KEYED,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      manifest: {
        ...agentManifest(false),
        name: KEYED,
        dependencies: { integrations: { [API]: "^1.0.0" } },
        integrations_configuration: {
          [API]: { tools: ["api_call__primary"], auth_key: "primary" },
        },
      },
    });
    const member = await memberContext(ctx, "member");
    await db.insert(integrationConnections).values({
      integrationId: API,
      authKey: "backup",
      accountId: "member-spare",
      spaceId: ctx.defaultSpaceId,
      userId: member.user.id,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
      scopesGranted: [],
      label: "member-spare",
    });
    const createAs = (actor?: string) =>
      app.request(`/api/agents/${KEYED}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "0 9 * * *",
          ...(actor ? { actor: { userId: actor } } : {}),
        }),
      });

    // Control: the caller's own fire names the auth its own `backup` row uses.
    const own = await createAs();
    expect(own.status).toBe(201);
    expect(((await own.json()) as WriteBody).warnings).toEqual([
      expect.objectContaining({
        code: "auth_key_mismatch",
        required_auth_key: "primary",
        available_auth_keys: ["backup"],
      }),
    ]);

    const forMember = await createAs(member.user.id);
    expect(forMember.status).toBe(201);
    expect(((await forMember.json()) as WriteBody).warnings).toEqual([]);
  });

  it("accepts it when an admin pin binds it — the pin, not the schedule, is what to fix", async () => {
    await db.insert(integrationPins).values({
      spaceId: ctx.defaultSpaceId,
      packageId: AGENT,
      integrationId: API,
      userId: null,
      connectionIds: [backup],
    });
    expect((await create({})).status).toBe(201);
  });
});

describe("schedule writes for an end user — the caller picks among its connections", () => {
  let ctx: TestContext;
  let endUserId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "schedchoice" });
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedSchedulableAgent({
      id: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      manifest: agentManifest(true),
    });
    endUserId = (
      await seedEndUser({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId, externalId: "ext-eu" })
    ).id;
  });

  async function seedEndUserConnection(label: string): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: "primary",
        accountId: label,
        spaceId: ctx.defaultSpaceId,
        endUserId,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
        scopesGranted: [],
        label,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  function createForEndUser(body: Record<string, unknown> = {}) {
    return app.request(`/api/agents/${AGENT}/schedules`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expression: "0 9 * * *", actor: { endUserId }, ...body }),
    });
  }

  it("lists the end user's own connections, and naming one arms the schedule", async () => {
    const a = await seedEndUserConnection("a");
    const b = await seedEndUserConnection("b");

    const refused = await createForEndUser();
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as ProblemBody;
    expect(body.errors[0]!.code).toBe("must_choose_connection");
    expect(body.errors[0]!.candidate_connections!.map((c) => c.id).sort()).toEqual([a, b].sort());
    expect(body.errors[0]!.message).toContain("connection_overrides");

    expect((await createForEndUser({ connection_overrides: { [INTEGRATION]: [a] } })).status).toBe(
      201,
    );
  });
});
