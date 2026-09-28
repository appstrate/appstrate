// SPDX-License-Identifier: Apache-2.0

/**
 * A scheduled fire whose version resolution fails leaves a VISIBLE failed run,
 * whatever the failure is — not only a typed `ApiError`. A storage fault while
 * reading the published archive used to be swallowed into "no archive", so the
 * fire failed blaming the version (`version_artifact_unavailable`) for what was
 * an infrastructure fault. It now fails with a fixed message; the raw error
 * goes to the logs only, never into a row the operator reads.
 *
 * Tier 0: `triggerScheduledRun` is called directly, like the sibling
 * activation-gate suite.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import * as storage from "@appstrate/db/storage";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPublishedVersion, seedSpacePackage } from "../../helpers/seed.ts";
import { createSchedule, triggerScheduledRun } from "../../../src/services/scheduler.ts";
import { AGENT_PACKAGES_BUCKET } from "../../../src/services/package-storage-keys.ts";
import type { Actor } from "../../../src/lib/actor.ts";

getTestApp();

const AGENT = "@sched/published-worker";

let ctx: TestContext;
let actor: Actor;
let scheduleId: string;
let restoreStorage: (() => void) | null = null;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  actor = { type: "user", id: ctx.user.id };
  await seedPackage({
    id: AGENT,
    orgId: ctx.orgId,
    homeSpaceId: ctx.defaultSpaceId,
    draftManifest: { name: AGENT, version: "0.1.0", type: "agent", description: "Scheduled" },
    draftContent: "Scheduled prompt",
  });
  await seedPublishedVersion(AGENT, "0.1.0");
  await seedSpacePackage(ctx.defaultSpaceId, AGENT);
  // No `versionOverride`: the fire resolves the latest PUBLISHED version,
  // which is the read the storage fault below lands on.
  const schedule = await createSchedule(
    { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
    AGENT,
    actor,
    { cronExpression: "0 3 * * *" },
  );
  scheduleId = schedule.id;
});

afterEach(() => {
  restoreStorage?.();
  restoreStorage = null;
});

describe("scheduled fire — version resolution failures", () => {
  it("records a failed run when reading the published archive throws a non-API error", async () => {
    // Only the published archive fails; draft reads keep working, so the fire
    // reaches version resolution before anything throws.
    const original = storage.downloadFile;
    const downloadSpy = spyOn(storage, "downloadFile").mockImplementation(async (bucket, path) => {
      if (bucket === AGENT_PACKAGES_BUCKET) throw new Error("storage unreachable");
      return original(bucket, path);
    });
    restoreStorage = () => downloadSpy.mockRestore();

    await triggerScheduledRun(scheduleId, AGENT, actor, ctx.orgId, ctx.defaultSpaceId, undefined);

    // The fault was actually injected on this path — otherwise the assertion
    // below could pass for an unrelated downstream failure.
    expect(downloadSpy).toHaveBeenCalled();
    const rows = await db.select().from(runs).where(eq(runs.scheduleId, scheduleId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    // The row is user-visible: it names the failure, never the raw storage
    // error (which stays in the logs, where infra details belong).
    expect(rows[0]!.error).toContain("The scheduled version could not be loaded (internal error)");
    expect(rows[0]!.error).not.toContain("storage unreachable");
  });
});
