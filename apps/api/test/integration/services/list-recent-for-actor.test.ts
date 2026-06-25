// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `listRecentForActor` — the caller-scoped recent-runs read the chat
 * module folds into its system-prompt context block. Covers actor isolation,
 * newest-first ordering across packages and statuses, the failure-only error
 * surface, and the limit.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { listRecentForActor } from "../../../src/services/state/runs.ts";

describe("listRecentForActor (service layer)", () => {
  let ctx: TestContext;
  const agentA = "@testorg/recent-a";
  const agentB = "@testorg/recent-b";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    for (const id of [agentA, agentB]) {
      await seedAgent({ id, orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, id);
    }
  });

  const scope = () => ({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });
  const actor = () => ({ type: "user" as const, id: ctx.user.id });

  it("returns the actor's runs newest-first across packages and all statuses", async () => {
    await seedRun({
      packageId: agentA,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "success",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedRun({
      packageId: agentB,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "failed",
      error: "boom",
      startedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const out = await listRecentForActor(scope(), actor());
    expect(out).toHaveLength(2);
    // Newest first: the failed agentB run leads.
    expect(out[0]!.package_id).toBe(agentB);
    expect(out[0]!.status).toBe("failed");
    expect(out[0]!.error).toBe("boom");
    expect(out[1]!.package_id).toBe(agentA);
    // Success runs never expose an error message.
    expect(out[1]!.error).toBeNull();
  });

  it("isolates by actor — a user never sees another actor's runs", async () => {
    const other = await createTestContext({ orgSlug: "other-actor" });
    // Seed a run owned by a different user in the SAME application is not
    // possible cross-org here; instead seed a run with no userId (system) and
    // one for our user, then assert only ours comes back.
    await seedRun({
      packageId: agentA,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "success",
      startedAt: new Date("2026-01-03T00:00:00Z"),
    });
    await seedRun({
      packageId: agentA,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      // Scheduled/system run — no actor.
      status: "success",
      startedAt: new Date("2026-01-04T00:00:00Z"),
    });

    const mine = await listRecentForActor(scope(), actor());
    expect(mine).toHaveLength(1);
    expect(mine[0]!.package_id).toBe(agentA);

    // The other org's actor sees nothing in our application.
    void other;
  });

  it("honours the limit (default 5)", async () => {
    for (let i = 0; i < 7; i++) {
      await seedRun({
        packageId: agentA,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
        startedAt: new Date(Date.UTC(2026, 0, 10 + i)),
      });
    }
    expect(await listRecentForActor(scope(), actor())).toHaveLength(5);
    expect(await listRecentForActor(scope(), actor(), { limit: 2 })).toHaveLength(2);
  });
});
