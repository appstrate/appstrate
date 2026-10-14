// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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
import { seedAgent, seedSpacePackage, seedRun } from "../../helpers/seed.ts";
import {
  computeRequestHash,
  idempotencyPrincipal,
  storeIdempotencyResult,
} from "../../../src/lib/idempotency.ts";
import {
  createFakeOrchestrator,
  inlineAgentManifest,
  seedConnectionTestIntegration,
  seedDefaultOrgModel,
  seedIntegrationConnection,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";

const app = getTestApp();
beforeEach(truncateAll);

const WARNING = {
  field: "integrations.@idem-review/svc",
  code: "not_connected",
  title: "Integration Not Connected",
  message:
    "Integration '@idem-review/svc' has no connection accessible to this actor; the run proceeds without it.",
};

/** Stores `body` as the launch `ctx`'s own session made with `key`. */
function cacheLaunch(ctx: TestContext, key: string, path: string, body: unknown) {
  const principal = idempotencyPrincipal({
    authMethod: "session",
    apiKeyId: null,
    clientId: null,
    actor: { type: "user", id: ctx.user.id },
  });
  const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId, principal };
  return storeIdempotencyResult(scope, key, {
    statusCode: 201,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    requestHash: computeRequestHash(
      new Request(`http://localhost${path}`, { method: "POST" }),
      "{}",
    ),
  });
}

describe("run replay respects current permissions on the real test application", () => {
  it("withholds imposed input on cached replay and rejects a viewer", async () => {
    const owner = await createTestContext({ orgSlug: "idem-review" });
    const runner = await memberContext(owner, "member", "runner");
    const outsider = await memberContext(owner, "member", "runner");
    const viewer = await memberContext(owner, "member", "viewer");
    const packageId = "@idem-review/agent";
    const path = `/api/agents/${packageId}/run`;
    // Homed here: `requireAgent()` resolves the agent by the placement rule, so
    // a placement row with no home and no offer reaches nothing.
    await seedAgent({
      id: packageId,
      orgId: owner.orgId,
      homeSpaceId: owner.defaultSpaceId,
      createdBy: owner.user.id,
    });
    await seedSpacePackage(owner.defaultSpaceId, packageId);
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
    // A launch response: the run plus the launch's `warnings`, stored for each caller as if
    // each had launched it with `key` — a key replays only to the principal that sent it.
    const launched = { ...JSON.parse(fullText), warnings: [WARNING] };
    for (const ctx of [owner, runner, outsider, viewer])
      await cacheLaunch(ctx, key, path, launched);
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
    expect(((await normal.json()) as { input: unknown }).input).toBeNull();
    const replayAs = (ctx: TestContext) =>
      app.request(path, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Idempotency-Key": key },
        body: "{}",
      });
    const hidden = await replayAs(outsider);
    expect(hidden.status).toBe(404);
    const replay = await replayAs(runner);
    const replayBody = (await replay.json()) as { id: string; input: unknown; warnings: unknown };
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
    expect(replayBody.warnings).toEqual([WARNING]);
    expect(viewerDirect.status).toBe(403);
    const again = await replayAs(owner);
    expect(again.status).toBe(201);
    expect(((await again.json()) as { input: unknown }).input).toEqual({
      imposed: "SYNTHETIC-IMPOSED-VALUE",
    });
    expect(viewerReplay.status).toBe(403);
    await assertDbCount(runs, eq(runs.orgId, owner.orgId), 1);
    await db.delete(runs).where(eq(runs.id, run.id));
    const deleted = await replayAs(owner);
    expect(deleted.status).toBe(404);
    await assertDbCount(runs, eq(runs.orgId, owner.orgId), 0);
  });

  it("replays the cached body with its run fields re-read", async () => {
    const owner = await createTestContext({ orgSlug: "idem-shape" });
    const packageId = "@idem-shape/agent";
    const path = `/api/agents/${packageId}/run`;
    await seedAgent({
      id: packageId,
      orgId: owner.orgId,
      homeSpaceId: owner.defaultSpaceId,
      createdBy: owner.user.id,
    });
    await seedSpacePackage(owner.defaultSpaceId, packageId);
    const run = await seedRun({
      orgId: owner.orgId,
      spaceId: owner.defaultSpaceId,
      packageId,
      userId: owner.user.id,
      status: "failed",
    });
    const key = crypto.randomUUID();
    await cacheLaunch(owner, key, path, { id: run.id, status: "pending", warnings: [WARNING] });

    const replay = await app.request(path, {
      method: "POST",
      headers: { ...authHeaders(owner), "Idempotency-Key": key },
      body: "{}",
    });
    expect(replay.status).toBe(201);
    const body = (await replay.json()) as Record<string, unknown>;
    expect(body.id).toBe(run.id);
    expect(body.status).toBe("failed"); // re-read, not the cached value
    expect(body.warnings).toEqual([WARNING]);
  });
});

describe("a refused launch is not stored", () => {
  beforeAll(() => _setOrchestratorForTesting(createFakeOrchestrator()));
  afterAll(() => _setOrchestratorForTesting(null));
  afterEach(waitForRunPipelineSettled);

  it("judges a retry with the same key again, and launches once the connection exists", async () => {
    const ctx = await createTestContext({ orgSlug: "idem-refused" });
    const integration = "@idem-refused/svc";
    await seedConnectionTestIntegration(ctx, integration);
    await seedDefaultOrgModel(ctx);
    const key = crypto.randomUUID();
    const body = JSON.stringify({
      manifest: inlineAgentManifest([integration], { required: [integration] }),
      prompt: "do the thing",
    });
    const launch = () =>
      app.request("/api/runs/inline", {
        method: "POST",
        headers: {
          ...authHeaders(ctx),
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body,
      });

    for (const attempt of [await launch(), await launch()]) {
      expect(attempt.status).toBe(409);
      expect(((await attempt.json()) as { code: string }).code).toBe(
        "missing_integration_connection",
      );
      expect(attempt.headers.get("Idempotent-Replayed")).toBeNull();
    }

    await seedIntegrationConnection(ctx, integration);
    const launched = await launch();
    expect(launched.status).toBe(201);
    expect(launched.headers.get("Idempotent-Replayed")).toBeNull();
    const { id } = (await launched.json()) as { id: string };

    const replay = await launch();
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(((await replay.json()) as { id: string }).id).toBe(id);
    await assertDbCount(runs, eq(runs.orgId, ctx.orgId), 1);
  });
});

describe("a launch key belongs to the caller that sent it", () => {
  beforeAll(() => _setOrchestratorForTesting(createFakeOrchestrator()));
  afterAll(() => _setOrchestratorForTesting(null));
  afterEach(waitForRunPipelineSettled);

  it("launches a run of its own for another member sending the same key and body", async () => {
    const ctx = await createTestContext({ orgSlug: "idem-caller" });
    const other = await memberContext(ctx, "member", "admin");
    await seedDefaultOrgModel(ctx);
    const key = "nightly";
    const body = JSON.stringify({ manifest: inlineAgentManifest(), prompt: "do the thing" });
    const launch = (as: TestContext) =>
      app.request("/api/runs/inline", {
        method: "POST",
        headers: { ...authHeaders(as), "Content-Type": "application/json", "Idempotency-Key": key },
        body,
      });

    const first = await launch(ctx);
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };

    const theirs = await launch(other);
    expect(theirs.status).toBe(201);
    expect(theirs.headers.get("Idempotent-Replayed")).toBeNull();
    expect(((await theirs.json()) as { id: string }).id).not.toBe(id);

    const retry = await launch(ctx);
    expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
    expect(((await retry.json()) as { id: string }).id).toBe(id);
    await assertDbCount(runs, eq(runs.orgId, ctx.orgId), 2);
  });
});
