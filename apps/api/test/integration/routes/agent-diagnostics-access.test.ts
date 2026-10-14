// SPDX-License-Identifier: Apache-2.0

/**
 * What an agent's overview reads is held to the same doors as the pages it
 * summarises: the diagnostics judge the definition the detail page renders
 * (a `draft` selector only for a caller who may write the agent) and report a
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
  seedRun,
  seedSchedule,
  seedSpaceMember,
} from "../../helpers/seed.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";

const app = getTestApp();

const AGENT = "@diagaccess/agent";

interface DiagnosticsBody {
  diagnostics: Array<{ code: string }>;
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

  const diagnostics = (headers: Record<string, string>, query = "") =>
    app.request(`/api/agents/${AGENT}/diagnostics${query}`, { headers });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "diagaccess" });
    await seedAgent({ id: AGENT, orgId: ctx.orgId, createdBy: ctx.user.id });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
  });

  describe("GET /api/agents/:scope/:name/diagnostics", () => {
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
      const codes = async (headers: Record<string, string>) => {
        const res = await diagnostics(headers);
        expect(res.status, await res.clone().text()).toBe(200);
        return ((await res.json()) as DiagnosticsBody).diagnostics.map((d) => d.code);
      };

      expect(await codes(authHeaders(ctx))).toContain("schedule_version_differs");

      const key = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["agents:read"],
      });
      expect(await codes({ Authorization: `Bearer ${key.rawKey}` })).not.toContain(
        "schedule_version_differs",
      );
    });
  });

  describe("GET /api/agents/:scope/:name/run-activity", () => {
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
        const res = await app.request(`/api/agents/${AGENT}/run-activity`, { headers });
        expect(res.status, await res.clone().text()).toBe(200);
        return (await res.json()) as { total: number; success: number; failed: number };
      };

      expect(await activity(authHeaders(ctx))).toMatchObject({ total: 3, success: 2, failed: 1 });
      expect(await activity(member.headers)).toMatchObject({ total: 1, success: 1, failed: 0 });
    });
  });
});
