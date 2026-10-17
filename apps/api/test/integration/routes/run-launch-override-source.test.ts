// SPDX-License-Identifier: Apache-2.0

/**
 * The launch-override layer is ONE cascade layer fed by whichever launched the
 * run, and the bound set records which: a run's `connection_overrides` bind as
 * `run_override`, a schedule fire's as `schedule_override`. Read off
 * `runs.resolved_connections`, the audit trail the credentials route and the
 * run's connections panel trust. An override adding to a set governance imposes
 * and closes, or naming what the caller cannot reach, is refused before any run
 * row exists; under an imposed set the override only adds, each bound row keeping
 * its own source. Ungoverned, an override naming no connection (`[]`) binds none,
 * and a non-required integration nobody connected, or switched off in the space,
 * starts the run with a warning.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { and, eq, isNotNull } from "drizzle-orm";
import { integrationConnections, integrationPins, runs } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedAgent, seedSchedule, seedSpace } from "../../helpers/seed.ts";
import { seedShares } from "../../helpers/connection-shares.ts";
import { activatePackage, deactivatePackage } from "../../../src/services/space-packages.ts";
import { setBlockUserConnections } from "../../../src/services/integration-pins-service.ts";
import { RUN_CONNECT_OFFERS_HEADER } from "@appstrate/core/run-and-wait-client";
import { triggerScheduledRun } from "../../../src/services/scheduler.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import {
  createFakeOrchestrator,
  seedConnectionTestIntegration,
  seedDefaultOrgModel,
  seedIntegrationConnection,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";

const app = getTestApp();

const AGENT = "@launchorg/agent";
const INTEGRATION = "@launchorg/svc";
const OPTIONAL_AGENT = "@launchorg/optional-agent";
const UNCONNECTED = "@launchorg/unconnected";

/** One-integration agent manifest; `required` marks it so in `integrations_configuration`. */
function agentManifest(name: string, integration: string, required = false) {
  return {
    name,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.2",
    display_name: "Launch Override Agent",
    dependencies: { integrations: { [integration]: "^1.0.0" } },
    integrations_configuration: { [integration]: { tools: ["search"], required } },
  };
}

interface LaunchWarning {
  field: string;
  code: string;
  auth_key?: string;
  required_scopes?: string[];
  connect_url?: string;
}

describe("launch override — the bound set names the launch it came from", () => {
  let ctx: TestContext;
  let picked: string;
  let other: string;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "launchorg" });
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedDefaultOrgModel(ctx);
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: agentManifest(AGENT, INTEGRATION),
      draftContent: "Search for something.",
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
    // Two own connections: without a pick the fallback refuses (must_choose),
    // so a run that starts proves the override was the layer that bound.
    picked = await seedIntegrationConnection(ctx, INTEGRATION);
    other = await seedIntegrationConnection(ctx, INTEGRATION);
  });

  function launch(ids: string[], headers: Record<string, string> = {}) {
    return app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ connection_overrides: { [INTEGRATION]: ids } }),
    });
  }

  /** The one refusal item of a `409 missing_integration_connection`, the response text beside it. */
  async function refusal(res: Response): Promise<{ code: string; text: string }> {
    expect(res.status).toBe(409);
    const text = await res.text();
    const body = JSON.parse(text) as { code: string; errors: { field: string; code: string }[] };
    expect(body.code).toBe("missing_integration_connection");
    expect(body.errors.map((e) => e.field)).toEqual([`integrations.${INTEGRATION}`]);
    return { code: body.errors[0]!.code, text };
  }

  /** `integrations_unbound` as `GET /api/runs/{id}` serves it. */
  async function unboundOnRun(runId: string): Promise<unknown> {
    const res = await app.request(`/api/runs/${runId}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { integrations_unbound: unknown }).integrations_unbound;
  }

  it("a run's connection_overrides bind as run_override, and are kept on the row", async () => {
    const res = await launch([picked]);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const [row] = await db.select().from(runs).where(eq(runs.id, id));
    expect(row!.resolvedConnections).toMatchObject({
      [INTEGRATION]: [{ connectionId: picked, source: "run_override" }],
    });
    expect(row!.connectionOverrides).toEqual({ [INTEGRATION]: [picked] });
    // Recorded, and nothing to record.
    expect(await unboundOnRun(id)).toEqual([]);
    await waitForRunPipelineSettled();
  });

  it("binds every connection the override names, in its order", async () => {
    const res = await launch([other, picked]);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const [row] = await db.select().from(runs).where(eq(runs.id, id));
    expect(row!.resolvedConnections).toMatchObject({
      [INTEGRATION]: [
        { connectionId: other, source: "run_override" },
        { connectionId: picked, source: "run_override" },
      ],
    });
    await waitForRunPipelineSettled();
  });

  it("refuses an override outside the admin pin (override_outranked) and creates no run", async () => {
    await db.insert(integrationPins).values({
      spaceId: ctx.defaultSpaceId,
      packageId: AGENT,
      integrationId: INTEGRATION,
      userId: null,
      connectionIds: [picked],
    });

    expect((await refusal(await launch([other]))).code).toBe("override_outranked");
    expect(await db.select().from(runs)).toHaveLength(0);
    // Control: an override inside the pin adds nothing and launches on the pin.
    const res = await launch([picked]);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const [row] = await db.select().from(runs).where(eq(runs.id, id));
    expect(row!.resolvedConnections).toMatchObject({
      [INTEGRATION]: [{ connectionId: picked, source: "admin_pin" }],
    });
    await waitForRunPipelineSettled();
  });

  describe("an admin pin open to additions", () => {
    beforeEach(async () => {
      await db.insert(integrationPins).values({
        spaceId: ctx.defaultSpaceId,
        packageId: AGENT,
        integrationId: INTEGRATION,
        userId: null,
        connectionIds: [picked],
        allowAdditionalConnections: true,
      });
    });

    async function boundOf(res: Response): Promise<unknown> {
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const [row] = await db.select().from(runs).where(eq(runs.id, id));
      return row!.resolvedConnections;
    }

    it("a manual run binds the imposed connection and the member pin, each with its source", async () => {
      await db.insert(integrationPins).values({
        spaceId: ctx.defaultSpaceId,
        packageId: AGENT,
        integrationId: INTEGRATION,
        userId: ctx.user.id,
        connectionIds: [other],
      });
      const res = await app.request(`/api/agents/${AGENT}/run?version=draft`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(await boundOf(res)).toEqual({
        [INTEGRATION]: [
          expect.objectContaining({ connectionId: picked, source: "admin_pin" }),
          expect.objectContaining({ connectionId: other, source: "member_pin" }),
        ],
      });
      await waitForRunPipelineSettled();
    });

    it("a run override adds to the imposed set and cannot remove it", async () => {
      expect(await boundOf(await launch([other]))).toEqual({
        [INTEGRATION]: [
          expect.objectContaining({ connectionId: picked, source: "admin_pin" }),
          expect.objectContaining({ connectionId: other, source: "run_override" }),
        ],
      });
      // `[]` is "no addition", never "no connection".
      expect(await boundOf(await launch([]))).toEqual({
        [INTEGRATION]: [expect.objectContaining({ connectionId: picked, source: "admin_pin" })],
      });
      await waitForRunPipelineSettled();
    });

    it("a schedule fire binds the imposed connection, then its own additions as schedule_override", async () => {
      const schedule = await seedSchedule({
        packageId: AGENT,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        connectionOverrides: { [INTEGRATION]: [picked, other] },
        versionOverride: "draft",
      });

      await triggerScheduledRun(schedule.id);

      const [row] = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(row!.status).not.toBe("failed");
      expect(row!.resolvedConnections).toEqual({
        [INTEGRATION]: [
          expect.objectContaining({ connectionId: picked, source: "admin_pin" }),
          expect.objectContaining({ connectionId: other, source: "schedule_override" }),
        ],
      });
      await waitForRunPipelineSettled();
    });

    describe("block_user_connections still bounds the additions", () => {
      let stray: string;
      let strayShared: string;

      /** The context user's ORG-scope connection, made in `originSpaceId`: it reaches every space. */
      async function orgConnectionFrom(originSpaceId: string): Promise<string> {
        const [row] = await db
          .insert(integrationConnections)
          .values({
            integrationId: INTEGRATION,
            authKey: "primary",
            accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
            orgId: ctx.orgId,
            spaceId: null,
            originSpaceId,
            userId: ctx.user.id,
            credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret" } }),
            scopesGranted: [],
            label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
          })
          .returning({ id: integrationConnections.id });
        return row!.id;
      }

      /** Replace the context user's member pin on (AGENT, INTEGRATION) with `connectionIds`. */
      async function memberPin(connectionIds: string[]): Promise<void> {
        await db
          .delete(integrationPins)
          .where(and(eq(integrationPins.packageId, AGENT), isNotNull(integrationPins.userId)));
        await db.insert(integrationPins).values({
          spaceId: ctx.defaultSpaceId,
          packageId: AGENT,
          integrationId: INTEGRATION,
          userId: ctx.user.id,
          connectionIds,
        });
      }

      const manualRun = () =>
        app.request(`/api/agents/${AGENT}/run?version=draft`, {
          method: "POST",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

      beforeEach(async () => {
        const elsewhere = await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" });
        stray = await orgConnectionFrom(elsewhere.id);
        strayShared = await orgConnectionFrom(elsewhere.id);
        await seedShares(strayShared, [ctx.defaultSpaceId]);
      });

      it("a run override: one made in another space, not shared, is refused; made here or shared, bound", async () => {
        // Control: unblocked, the connection made elsewhere is a valid addition.
        expect(await boundOf(await launch([stray]))).toEqual({
          [INTEGRATION]: [
            expect.objectContaining({ connectionId: picked, source: "admin_pin" }),
            expect.objectContaining({ connectionId: stray, source: "run_override" }),
          ],
        });
        await waitForRunPipelineSettled();
        await setBlockUserConnections(
          { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
          INTEGRATION,
          true,
        );
        const before = (await db.select().from(runs)).length;

        expect((await refusal(await launch([stray]))).code).toBe("override_connection_unavailable");
        expect(await db.select().from(runs)).toHaveLength(before);
        expect(await boundOf(await launch([strayShared, other]))).toEqual({
          [INTEGRATION]: [
            expect.objectContaining({ connectionId: picked, source: "admin_pin" }),
            expect.objectContaining({ connectionId: strayShared, source: "run_override" }),
            expect.objectContaining({ connectionId: other, source: "run_override" }),
          ],
        });
        await waitForRunPipelineSettled();
      });

      it("a member pin: one made in another space, not shared, is refused; made here or shared, bound", async () => {
        await memberPin([stray]);
        // Control: unblocked, the member pin adds the connection made elsewhere.
        expect(await boundOf(await manualRun())).toEqual({
          [INTEGRATION]: [
            expect.objectContaining({ connectionId: picked, source: "admin_pin" }),
            expect.objectContaining({ connectionId: stray, source: "member_pin" }),
          ],
        });
        await waitForRunPipelineSettled();
        await setBlockUserConnections(
          { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
          INTEGRATION,
          true,
        );

        const { code, text } = await refusal(await manualRun());
        expect(code).toBe("pinned_connection_unavailable");
        expect(text).toContain("Your pinned connection");
        await memberPin([strayShared, other]);
        expect(await boundOf(await manualRun())).toEqual({
          [INTEGRATION]: [
            expect.objectContaining({ connectionId: picked, source: "admin_pin" }),
            expect.objectContaining({ connectionId: strayShared, source: "member_pin" }),
            expect.objectContaining({ connectionId: other, source: "member_pin" }),
          ],
        });
        await waitForRunPipelineSettled();
      });
    });

    it("an addition the actor cannot reach is refused, the imposed row never bound alone", async () => {
      const colleague = await memberContext(ctx, "member");
      const theirs = await seedIntegrationConnection(colleague, INTEGRATION);
      expect((await refusal(await launch([theirs]))).code).toBe("override_connection_unavailable");
      expect(await db.select().from(runs)).toHaveLength(0);
    });
  });

  it("refuses a colleague's private connection like an unknown id, naming neither label nor account", async () => {
    const colleague = await memberContext(ctx, "member");
    const theirs = await seedIntegrationConnection(colleague, INTEGRATION, {
      label: "colleague-label",
      accountId: "colleague-account",
    });

    const { code, text } = await refusal(await launch([theirs]));
    expect(code).toBe("override_connection_unavailable");
    expect(text).not.toContain("colleague-label");
    expect(text).not.toContain("colleague-account");
    expect(await db.select().from(runs)).toHaveLength(0);
  });

  it("refuses a connection_overrides key the agent does not declare (400) and creates no run", async () => {
    // Before, the resolver read only declared ids, so a typo was dropped and a
    // lower layer bound instead of the account the caller asked for.
    const res = await app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        connection_overrides: { [INTEGRATION]: [picked], "@launchorg/typo": [other] },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; errors: unknown[] };
    expect(body.code).toBe("validation_failed");
    expect(body.errors).toEqual([
      expect.objectContaining({
        field: "connection_overrides.@launchorg/typo",
        code: "undeclared_connection_override",
      }),
    ]);
    expect(await db.select().from(runs)).toHaveLength(0);
  });

  it("refuses an undeclared connection_overrides key on the inline launch and its validator", async () => {
    const inline = {
      manifest: {
        name: "@inline/override-keys",
        display_name: "Inline",
        version: "0.0.0",
        type: "agent",
        schema_version: "0.2",
        dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
        integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
      },
      prompt: "Search for something.",
      connection_overrides: { "@launchorg/typo": [picked] },
    };
    const request = (path: string) =>
      app.request(path, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(inline),
      });

    const launched = await request("/api/runs/inline");
    expect(launched.status).toBe(400);
    const UNDECLARED = {
      field: "connection_overrides.@launchorg/typo",
      code: "undeclared_connection_override",
    };
    const refused = (await launched.json()) as { code: string; errors: unknown[] };
    expect(refused.code).toBe("validation_failed");
    expect(refused.errors).toEqual([expect.objectContaining(UNDECLARED)]);
    expect(await db.select().from(runs)).toHaveLength(0);

    const validated = await request("/api/runs/inline/validate");
    expect(validated.status).toBe(400);
    const body = (await validated.json()) as { code: string; errors: unknown[] };
    expect(body.code).toBe("validation_failed");
    expect(body.errors).toContainEqual(expect.objectContaining(UNDECLARED));
  });

  it("a schedule fire's frozen picks bind as schedule_override", async () => {
    const schedule = await seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      connectionOverrides: { [INTEGRATION]: [picked] },
      versionOverride: "draft",
    });

    await triggerScheduledRun(schedule.id);

    const [row] = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
    expect(row!.status).not.toBe("failed");
    expect(row!.resolvedConnections).toMatchObject({
      [INTEGRATION]: [{ connectionId: picked, source: "schedule_override" }],
    });
    // The pick lives on the schedule row; the run keeps only the caller's own overrides.
    expect(row!.connectionOverrides).toBeNull();
    await waitForRunPipelineSettled();
  });

  describe("explicit none", () => {
    it("an empty override binds no connection, warned without a connect link", async () => {
      const res = await launch([], { [RUN_CONNECT_OFFERS_HEADER]: "1" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; warnings: LaunchWarning[] };
      expect(body.warnings).toHaveLength(1);
      const [warning] = body.warnings;
      expect(warning).toMatchObject({
        field: `integrations.${INTEGRATION}`,
        code: "integration_unbound",
        source: "run_override",
        message: expect.stringContaining("this run's connection_overrides"),
      });
      // The absence was chosen: nothing to connect.
      expect(warning!.auth_key).toBeUndefined();
      expect(warning!.required_scopes).toBeUndefined();
      expect(warning!.connect_url).toBeUndefined();

      const [row] = await db.select().from(runs).where(eq(runs.id, body.id));
      expect(row!.resolvedConnections).toEqual({ [INTEGRATION]: [] });
      expect(row!.connectionOverrides).toEqual({ [INTEGRATION]: [] });
      expect(await unboundOnRun(body.id)).toEqual([
        {
          integration_package_id: INTEGRATION,
          code: "integration_unbound",
          source: "run_override",
        },
      ]);
      await waitForRunPipelineSettled();
    });

    it("an empty override adds nothing to an admin pin: the pin binds", async () => {
      await db.insert(integrationPins).values({
        spaceId: ctx.defaultSpaceId,
        packageId: AGENT,
        integrationId: INTEGRATION,
        userId: null,
        connectionIds: [picked],
      });

      const res = await launch([]);
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const [row] = await db.select().from(runs).where(eq(runs.id, id));
      expect(row!.resolvedConnections).toMatchObject({
        [INTEGRATION]: [{ connectionId: picked, source: "admin_pin" }],
      });
      await waitForRunPipelineSettled();
    });

    it("an empty override on a required integration: 409 ungoverned, the imposed set when governed", async () => {
      const required = "@launchorg/required-agent";
      await seedAgent({
        id: required,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: agentManifest(required, INTEGRATION, true),
        draftContent: "Search for something.",
      });
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, required);

      const res = await app.request(`/api/agents/${required}/run?version=draft`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connection_overrides: { [INTEGRATION]: [] } }),
      });
      // Ungoverned: the override's own `[]` leaves a required integration with nothing.
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        code: string;
        errors: { field: string; code: string; source?: string }[];
      };
      expect(body.code).toBe("missing_integration_connection");
      expect(body.errors.map((e) => [e.field, e.code, e.source])).toEqual([
        [`integrations.${INTEGRATION}`, "required_integration_unbound", "run_override"],
      ]);
      expect(await db.select().from(runs)).toHaveLength(0);

      // Governed: the same `[]` adds nothing, and the imposed set satisfies the integration.
      await db.insert(integrationPins).values({
        spaceId: ctx.defaultSpaceId,
        packageId: required,
        integrationId: INTEGRATION,
        userId: null,
        connectionIds: [picked],
      });
      const governed = await app.request(`/api/agents/${required}/run?version=draft`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connection_overrides: { [INTEGRATION]: [] } }),
      });
      expect(governed.status).toBe(201);
      const { id } = (await governed.json()) as { id: string };
      const [row] = await db.select().from(runs).where(eq(runs.id, id));
      expect(row!.resolvedConnections).toMatchObject({
        [INTEGRATION]: [{ connectionId: picked, source: "admin_pin" }],
      });
      await waitForRunPipelineSettled();
    });
  });

  describe("a non-required integration nobody connected", () => {
    beforeEach(async () => {
      await seedConnectionTestIntegration(ctx, UNCONNECTED);
    });

    async function seedOptionalAgent(required: boolean) {
      await seedAgent({
        id: OPTIONAL_AGENT,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: agentManifest(OPTIONAL_AGENT, UNCONNECTED, required),
        draftContent: "Search for something.",
      });
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, OPTIONAL_AGENT);
    }

    function launchOptional(headers: Record<string, string> = {}) {
      return app.request(`/api/agents/${OPTIONAL_AGENT}/run?version=draft`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json", ...headers },
        body: JSON.stringify({}),
      });
    }

    it("starts the run without it, warning not_connected and snapshotting an empty set", async () => {
      await seedOptionalAgent(false);

      const res = await launchOptional();
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; warnings: LaunchWarning[] };
      expect(body.warnings.map((w) => [w.field, w.code])).toEqual([
        [`integrations.${UNCONNECTED}`, "not_connected"],
      ]);
      const [row] = await db.select().from(runs).where(eq(runs.id, body.id));
      expect(row!.resolvedConnections).toEqual({ [UNCONNECTED]: [] });
      // The run keeps the warning's cause, not just the empty set.
      expect(await unboundOnRun(body.id)).toEqual([
        { integration_package_id: UNCONNECTED, code: "not_connected", source: null },
      ]);
      await waitForRunPipelineSettled();
    });

    it("replays the same warnings on an idempotent retry", async () => {
      await seedOptionalAgent(false);
      const headers = { "Idempotency-Key": crypto.randomUUID() };

      const first = (await (await launchOptional(headers)).json()) as {
        id: string;
        warnings: LaunchWarning[];
      };
      const replay = await launchOptional(headers);
      expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
      const replayed = (await replay.json()) as { id: string; warnings: LaunchWarning[] };
      expect(replayed.id).toBe(first.id);
      expect(replayed.warnings).toEqual(first.warnings);
      await waitForRunPipelineSettled();
    });

    it("refuses the launch when the agent marks it required (409 not_connected)", async () => {
      await seedOptionalAgent(true);

      const res = await launchOptional();
      expect(res.status).toBe(409);
      const body = (await res.json()) as { errors: LaunchWarning[] };
      expect(body.errors.map((e) => [e.field, e.code])).toEqual([
        [`integrations.${UNCONNECTED}`, "not_connected"],
      ]);
      expect(await db.select().from(runs)).toHaveLength(0);
    });

    it("a schedule fire starts without it", async () => {
      await seedOptionalAgent(false);
      const schedule = await seedSchedule({
        packageId: OPTIONAL_AGENT,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        versionOverride: "draft",
      });

      await triggerScheduledRun(schedule.id);

      const [row] = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(row!.resolvedConnections).toEqual({ [UNCONNECTED]: [] });
      // A fire returns its warnings to no one: the run is where they are read.
      expect(await unboundOnRun(row!.id)).toEqual([
        { integration_package_id: UNCONNECTED, code: "not_connected", source: null },
      ]);
      await waitForRunPipelineSettled();
    });
  });
  describe("an integration switched off in the space", () => {
    beforeEach(async () => {
      await deactivatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION);
    });

    it("non-required: starts the run without it, warning integration_not_active", async () => {
      // Two own connections would be `must_choose_connection` were it active: the snapshot
      // pass must not judge an integration the run will not start.
      const res = await app.request(`/api/agents/${AGENT}/run?version=draft`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; warnings: LaunchWarning[] };
      expect(body.warnings.map((w) => [w.field, w.code])).toEqual([
        [`integrations.${INTEGRATION}`, "integration_not_active"],
      ]);
      const [row] = await db.select().from(runs).where(eq(runs.id, body.id));
      expect(row!.resolvedConnections).toEqual({ [INTEGRATION]: [] });
      expect(await unboundOnRun(body.id)).toEqual([
        { integration_package_id: INTEGRATION, code: "integration_not_active", source: null },
      ]);
      await waitForRunPipelineSettled();
    });

    it("required: refuses the launch (409 integration_not_active) and creates no run", async () => {
      const required = "@launchorg/required-agent";
      await seedAgent({
        id: required,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: agentManifest(required, INTEGRATION, true),
        draftContent: "Search for something.",
      });
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, required);

      const res = await app.request(`/api/agents/${required}/run?version=draft`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connection_overrides: { [INTEGRATION]: [picked] } }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { errors: LaunchWarning[] };
      expect(body.errors.map((e) => [e.field, e.code])).toEqual([
        [`integrations.${INTEGRATION}`, "integration_not_active"],
      ]);
      expect(await db.select().from(runs)).toHaveLength(0);
    });
  });
});
