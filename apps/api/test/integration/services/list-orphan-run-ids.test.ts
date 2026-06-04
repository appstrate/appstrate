// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `listOrphanRunIds` heartbeat-freshness filtering (finding #25).
 *
 * A booting instance feeds the returned ids through `synthesiseFinalize`.
 * In a multi-instance deployment it must NOT finalize runs that a sibling
 * instance is actively heartbeating — only runs whose `last_heartbeat_at`
 * has slipped past the watchdog stall threshold are treated as orphans.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { listOrphanRunIds } from "../../../src/services/state/runs.ts";
import { getEnv } from "@appstrate/env";

describe("listOrphanRunIds — heartbeat-freshness filtering", () => {
  let ctx: TestContext;
  const agentId = "@testorg/orphan-agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  it("excludes a freshly-heartbeating run and includes a stale one", async () => {
    const stallSeconds = getEnv().RUN_STALL_THRESHOLD_SECONDS;
    const now = Date.now();

    // Sibling-owned: heartbeat well within the stall threshold → excluded.
    const fresh = await seedRun({
      packageId: agentId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
      lastHeartbeatAt: new Date(now - Math.floor((stallSeconds / 2) * 1000)),
    });

    // Stale: heartbeat slipped well past the threshold → orphan, included.
    const stale = await seedRun({
      packageId: agentId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
      lastHeartbeatAt: new Date(now - (stallSeconds + 60) * 1000),
    });

    const ids = await listOrphanRunIds();

    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);
  });

  it("ignores runs in a terminal status regardless of heartbeat", async () => {
    const stallSeconds = getEnv().RUN_STALL_THRESHOLD_SECONDS;
    const staleTerminal = await seedRun({
      packageId: agentId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
      lastHeartbeatAt: new Date(Date.now() - (stallSeconds + 60) * 1000),
    });

    const ids = await listOrphanRunIds();
    expect(ids).not.toContain(staleTerminal.id);
  });
});
