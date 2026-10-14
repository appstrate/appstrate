// SPDX-License-Identifier: Apache-2.0

/**
 * What an agent's overview reads is held to the same doors as the pages it
 * summarises: the diagnostics judge the definition the detail page renders
 * (a `draft` selector only for a caller who may write the agent), report
 * connection verdicts only to a caller who may read integrations and a
 * schedule only to a caller who may read schedules; the 30-day run activity
 * counts only the runs the caller may read.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedAgent,
  seedApiKey,
  seedPackage,
  seedPublishedVersion,
  seedRun,
  seedSchedule,
  seedSpaceMember,
  seedUnreachableSpace,
} from "../../helpers/seed.ts";
import { activatePackage, deactivatePackage } from "../../../src/services/space-packages.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const AGENT = "@diagaccess/agent";

interface DiagnosticsBody {
  diagnostics: Array<{ code: string; correction: { params: Record<string, string> } }>;
}

describe("agent overview reads — access", () => {
  let ctx: TestContext;

  /** A member holding `operator` in the default space: agents:read, schedules:read, own runs. */
  async function operator() {
    const user = await createTestUser();
    await addOrgMember(ctx.orgId, user.id, "member");
    await seedSpaceMember({ spaceId: ctx.defaultSpaceId, userId: user.id, presetRole: "operator" });
    return {
      userId: user.id,
      headers: { Cookie: user.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": ctx.defaultSpaceId },
    };
  }

  const diagnostics = (headers: Record<string, string>, query = "", agent = AGENT) =>
    app.request(`/api/agents/${agent}/diagnostics${query}`, { headers });

  const runActivity = (headers: Record<string, string>, agent = AGENT) =>
    app.request(`/api/agents/${agent}/run-activity`, { headers });

  /** An agent homed in a space nobody here reaches, and offered nowhere. */
  async function unreadableAgent() {
    const agent = "@diagaccess/elsewhere";
    await seedAgent({
      id: agent,
      orgId: ctx.orgId,
      homeSpaceId: await seedUnreachableSpace(ctx.orgId),
    });
    return agent;
  }

  const codes = async (headers: Record<string, string>, agent = AGENT) => {
    const res = await diagnostics(headers, "", agent);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as DiagnosticsBody).diagnostics.map((d) => d.code);
  };

  /** A bearer key of the org owner, narrowed to `scopes`. */
  async function keyHolding(scopes: string[]) {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes,
    });
    return { Authorization: `Bearer ${key.rawKey}` };
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "diagaccess" });
    await seedAgent({ id: AGENT, orgId: ctx.orgId, createdBy: ctx.user.id });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
  });

  describe("GET /api/agents/:scope/:name/diagnostics", () => {
    it("refuses a caller without agents:read", async () => {
      const res = await diagnostics(await keyHolding(["runs:read"]));
      expect(res.status, await res.clone().text()).toBe(403);
      // The discriminating control: the same grant plus agents:read is answered.
      expect((await diagnostics(await keyHolding(["runs:read", "agents:read"]))).status).toBe(200);
    });

    it("answers 404 for an agent this space cannot read", async () => {
      const res = await diagnostics(authHeaders(ctx), "", await unreadableAgent());
      expect(res.status, await res.clone().text()).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("agent_not_found");
    });

    it("refuses an explicit ?version=draft to a reader who cannot write the agent", async () => {
      const { headers } = await operator();
      const named = await diagnostics(headers, "?version=draft");
      expect(named.status, await named.clone().text()).toBe(403);
      expect(((await named.json()) as { code: string }).code).toBe("draft_not_writable");

      // The discriminating control: the same caller without a selector, and
      // the author with it, are both answered.
      expect((await diagnostics(headers)).status).toBe(200);
      expect((await diagnostics(authHeaders(ctx), "?version=draft")).status).toBe(200);
    });

    it("reports connection verdicts only to a caller holding integrations:read", async () => {
      const integration = "@diagaccess/svc";
      const agent = "@diagaccess/connected";
      await seedPackage({
        id: integration,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        type: "integration",
        source: "local",
        draftManifest: localIntegrationManifest({
          name: integration,
          serverName: "@diagaccess/svc-server",
          version: "1.0.0",
          auths: {
            primary: {
              type: "api_key",
              authorizedUris: ["https://api.example.com/**"],
              credentialFields: ["api_key"],
              delivery: httpHeaderDelivery({ name: "Authorization", field: "api_key" }),
            },
          },
          tools_policy: { search: {} },
        }),
      });
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, integration);
      await seedAgent({
        id: agent,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: agent,
          version: "1.0.0",
          type: "agent",
          dependencies: { integrations: { [integration]: "^1.0.0" } },
          integrations_configuration: { [integration]: { tools: ["search"], required: true } },
        },
      });
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, agent);

      expect(await codes(await keyHolding(["agents:read", "integrations:read"]), agent)).toContain(
        "not_connected",
      );
      // The rest of the diagnostics still reach an agents:read-only caller.
      const agentsOnly = await codes(await keyHolding(["agents:read"]), agent);
      expect(agentsOnly).not.toContain("not_connected");
      expect(agentsOnly).toContain("model_not_configured");
    });

    it("reports a switched-off agent to every reader, as the launch refuses it", async () => {
      await deactivatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
      const res = await diagnostics(await keyHolding(["agents:read"]));
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as DiagnosticsBody;
      expect(body.diagnostics[0]).toMatchObject({
        code: "agent_not_active",
        field: "agent",
        correction: { destination: "configuration", section: "activation", params: {} },
      });
      // Once, whoever may also read the connections.
      expect((await codes(authHeaders(ctx))).filter((c) => c === "agent_not_active")).toHaveLength(
        1,
      );
    });

    it("compares a schedule by the version it runs, not by its selector", async () => {
      await seedPublishedVersion(AGENT, "1.0.0");
      const schedule = (versionOverride: string | null) =>
        seedSchedule({
          packageId: AGENT,
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          userId: ctx.user.id,
          name: `runs ${versionOverride}`,
          cronExpression: "0 3 * * *",
          timezone: "UTC",
          versionOverride,
        });

      // A reader who may not write the agent inspects the published 1.0.0,
      // which a schedule pinned to `1.0.0` also runs.
      await schedule("1.0.0");
      const reader = await keyHolding(["agents:read", "schedules:read"]);
      expect(await codes(reader)).not.toContain("schedule_version_differs");

      // The author inspects the draft; an unpinned schedule runs 1.0.0.
      await schedule(null);
      const res = await diagnostics(authHeaders(ctx));
      const differs = ((await res.json()) as DiagnosticsBody).diagnostics.filter(
        (d) => d.code === "schedule_version_differs",
      );
      expect(differs.map((d) => d.correction.params)).toEqual([
        expect.objectContaining({ schedule_version: "1.0.0", inspected_version: "draft" }),
        expect.objectContaining({ schedule_version: "1.0.0", inspected_version: "draft" }),
      ]);
    });

    it("reports a schedule only to a caller holding schedules:read", async () => {
      await seedSchedule({
        packageId: AGENT,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        name: "nightly",
        cronExpression: "0 3 * * *",
        timezone: "UTC",
        versionOverride: "1.0.0",
      });
      expect(await codes(authHeaders(ctx))).toContain("schedule_version_differs");
      expect(await codes(await keyHolding(["agents:read"]))).not.toContain(
        "schedule_version_differs",
      );
    });
  });

  describe("GET /api/agents/:scope/:name/run-activity", () => {
    it("refuses a caller without runs:read", async () => {
      const res = await runActivity(await keyHolding(["agents:read"]));
      expect(res.status, await res.clone().text()).toBe(403);
      // The discriminating control: the same grant plus runs:read is answered.
      expect((await runActivity(await keyHolding(["agents:read", "runs:read"]))).status).toBe(200);
    });

    it("answers 404 for an agent this space cannot read", async () => {
      const res = await runActivity(authHeaders(ctx), await unreadableAgent());
      expect(res.status, await res.clone().text()).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("agent_not_found");
    });

    it("counts only the runs the caller may read", async () => {
      const member = await operator();
      const seed = (userId: string, status: "success" | "failed") =>
        seedRun({
          packageId: AGENT,
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          userId,
          status,
          startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        });
      await seed(ctx.user.id, "success");
      await seed(ctx.user.id, "failed");
      await seed(member.userId, "success");

      const activity = async (headers: Record<string, string>) => {
        const res = await runActivity(headers);
        expect(res.status, await res.clone().text()).toBe(200);
        return (await res.json()) as { total: number; success: number; failed: number };
      };

      expect(await activity(authHeaders(ctx))).toMatchObject({ total: 3, success: 2, failed: 1 });
      expect(await activity(member.headers)).toMatchObject({ total: 1, success: 1, failed: 0 });
    });
  });
});
