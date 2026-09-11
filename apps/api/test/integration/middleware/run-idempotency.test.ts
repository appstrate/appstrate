// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { runs } from "@appstrate/db/schema";
import { db } from "@appstrate/db/client";
import { assertDbCount } from "../../helpers/assertions.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedAgent, seedInstalledPackage, seedRun } from "../../helpers/seed.ts";
import { computeRequestHash, storeIdempotencyResult } from "../../../src/lib/idempotency.ts";

const app = getTestApp();
beforeEach(truncateAll);

describe("run replay respects current permissions on the real test application", () => {
  it("withholds imposed input on cached replay and rejects a viewer", async () => {
    const owner = await createTestContext({ orgSlug: "idem-review" });
    const runner = await memberContext(owner, "member", "runner");
    const outsider = await memberContext(owner, "member", "runner");
    const viewer = await memberContext(owner, "member", "viewer");
    const packageId = "@idem-review/agent";
    const path = `/api/agents/${packageId}/run`;
    await seedAgent({ id: packageId, orgId: owner.orgId, createdBy: owner.user.id });
    await seedInstalledPackage(owner.defaultSpaceId, packageId);
    const run = await seedRun({
      orgId: owner.orgId,
      spaceId: owner.defaultSpaceId,
      packageId,
      userId: runner.user.id,
      status: "failed",
      input: { imposed: "SYNTHETIC-IMPOSED-VALUE" },
    });
    const full = await app.request(`/api/runs/${run.id}`, { headers: authHeaders(owner) });
    expect(full.status).toBe(200);
    const fullText = await full.text();
    expect(JSON.parse(fullText).input).toEqual({ imposed: "SYNTHETIC-IMPOSED-VALUE" });
    const key = crypto.randomUUID();
    await storeIdempotencyResult(owner.orgId, owner.defaultSpaceId, key, {
      statusCode: 201,
      headers: { "content-type": "application/json" },
      body: fullText,
      requestHash: computeRequestHash(
        new Request(`http://localhost${path}`, { method: "POST" }),
        "{}",
      ),
    });
    for (const alternate of [
      "/api/runs/remote",
      "/api/runs/inline",
      "/api/end-users",
      `${path}?version=draft`,
    ]) {
      const crossRoute = await app.request(alternate, {
        method: "POST",
        headers: { ...authHeaders(owner), "Idempotency-Key": key },
        body: "{}",
      });
      expect(crossRoute.status).toBe(422);
    }
    const normal = await app.request(`/api/runs/${run.id}`, { headers: authHeaders(runner) });
    expect(normal.status).toBe(200);
    expect((await normal.json()).input).toBeNull();
    const replayAs = (ctx: TestContext) =>
      app.request(path, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Idempotency-Key": key },
        body: "{}",
      });
    const hidden = await replayAs(outsider);
    expect(hidden.status).toBe(404);
    const replay = await replayAs(runner);
    const replayBody = await replay.json();
    const viewerReplay = await replayAs(viewer);
    const viewerDirect = await app.request(path, {
      method: "POST",
      headers: authHeaders(viewer),
      body: "{}",
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(replayBody.id).toBe(run.id);
    expect(replayBody.input).toBeNull();
    expect(viewerDirect.status).toBe(403);
    const again = await replayAs(owner);
    expect(again.status).toBe(201);
    expect((await again.json()).input).toEqual({ imposed: "SYNTHETIC-IMPOSED-VALUE" });
    expect(viewerReplay.status).toBe(403);
    await assertDbCount(runs, eq(runs.orgId, owner.orgId), 1);
    await db.delete(runs).where(eq(runs.id, run.id));
    const deleted = await replayAs(owner);
    expect(deleted.status).toBe(404);
    await assertDbCount(runs, eq(runs.orgId, owner.orgId), 0);
  });
});
