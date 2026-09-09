// SPDX-License-Identifier: Apache-2.0

/**
 * `runs:read` is ownership; `runs:read-all` is the space.
 *
 * Two colleagues holding the same `operator` preset in one space each read the
 * runs THEY launched — their manual runs and the runs of their own schedules —
 * and nothing else. A run they may not read is a 404, never a 403: a 403 would
 * confirm it exists.
 *
 * The fixture is deliberately five rows of four different attributions, because
 * the failure mode this pins is a predicate that is right for the easy pair and
 * wrong for the rest: A's manual run, B's manual run, the run of A's schedule
 * (attributed to A, since a schedule carries a frozen actor), an end-user's run
 * (`user_id NULL`, `end_user_id` set) and an actor-less row (both NULL) from a
 * launch path that predates #735. The narrowing predicate is `actorFilter`, not
 * `actorScopeFilter`: the latter's `user_id IS NULL` arm would hand A the last
 * two — exactly the supervision `read-all` exists to gate.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { db } from "../../helpers/db.ts";
import { files } from "@appstrate/db/schema";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedAgent,
  seedApiKey,
  seedEndUser,
  seedInstalledPackage,
  seedRun,
  seedSchedule,
} from "../../helpers/seed.ts";

const app = getTestApp();

const AGENT_ID = "@isolation/shared-agent";
const AGENT_PATH = `${encodeURIComponent("@isolation")}/shared-agent`;
/** The agent DETAIL lives under the packages router, not `/api/agents`. */
const AGENT_DETAIL_PATH = `/api/packages/agents/${AGENT_PATH}`;

interface RunList {
  data: { id: string }[];
  total: number;
}

describe("run read isolation between members", () => {
  /** Org owner — preset `admin` in the default space, so it holds `runs:read-all`. */
  let owner: TestContext;
  let operatorA: TestContext;
  let operatorB: TestContext;
  let endUserId: string;
  let scheduleId: string;
  /** The five rows, by the principal they are attributed to. */
  let runA: string;
  let runB: string;
  let runAScheduled: string;
  let runEndUser: string;
  let runLegacy: string;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "isolation" });
    operatorA = await memberContext(owner, "member", "operator");
    operatorB = await memberContext(owner, "member", "operator");

    await seedAgent({
      id: AGENT_ID,
      type: "agent",
      orgId: owner.orgId,
      createdBy: owner.user.id,
      draftManifest: {
        name: AGENT_ID,
        version: "0.1.0",
        type: "agent",
        // A declared file field is what makes an `appfile://` input MOUNT, and
        // therefore what runs it through the container ACL.
        input: {
          schema: {
            type: "object",
            properties: {
              attachment: { type: "string", format: "uri", contentMediaType: "text/plain" },
            },
          },
        },
      },
    });
    await seedInstalledPackage(owner.defaultSpaceId, AGENT_ID);

    const common = {
      packageId: AGENT_ID,
      orgId: owner.orgId,
      spaceId: owner.defaultSpaceId,
      status: "success" as const,
    };

    runA = (await seedRun({ ...common, userId: operatorA.user.id })).id;
    runB = (await seedRun({ ...common, userId: operatorB.user.id })).id;

    // A schedule freezes its actor (`services/scheduler.ts` refuses one with
    // none), and every run it fires is inserted with that actor — so A's own
    // schedule stays A's under plain `runs:read`.
    const schedule = await seedSchedule({
      packageId: AGENT_ID,
      orgId: owner.orgId,
      spaceId: owner.defaultSpaceId,
      userId: operatorA.user.id,
      enabled: true,
    });
    scheduleId = schedule.id;
    runAScheduled = (
      await seedRun({ ...common, userId: operatorA.user.id, scheduleId: schedule.id })
    ).id;

    const endUser = await seedEndUser({
      spaceId: owner.defaultSpaceId,
      orgId: owner.orgId,
      externalId: "ext-isolation",
    });
    endUserId = endUser.id;
    runEndUser = (await seedRun({ ...common, endUserId: endUser.id })).id;

    // Both actor columns NULL — unreachable from any live launch path, and
    // therefore visible to `read-all` alone.
    runLegacy = (await seedRun({ ...common, status: "success" })).id;
  });

  /**
   * A published output anchored to `runId`. Published files copy their run's
   * attribution, so the file's own columns carry the same actor.
   */
  async function seedOutput(
    runId: string,
    attribution: { userId?: string; endUserId?: string },
  ): Promise<string> {
    const id = `file_${crypto.randomUUID()}`;
    await db.insert(files).values({
      id,
      orgId: owner.orgId,
      spaceId: owner.defaultSpaceId,
      purpose: "agent_output",
      runId,
      storageKey: `files/${id}.txt`,
      name: `${id}.txt`,
      mime: "text/plain",
      size: 3,
      // A real 64-hex digest: the `/content` route derives an RFC 9530
      // Repr-Digest from it and refuses anything else.
      sha256: "a".repeat(64),
      ...attribution,
    });
    return id;
  }

  /** Ids the global list returns, newest first, for one set of headers. */
  async function listedRuns(headers: Record<string, string>, query = ""): Promise<string[]> {
    const res = await app.request(`/api/runs${query}`, { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as RunList).data.map((r) => r.id);
  }

  /** The four per-run surfaces, each answering 404 for a run the caller cannot read. */
  async function statusesFor(
    headers: Record<string, string>,
    runId: string,
  ): Promise<Record<string, number>> {
    const [detail, logs, cancel] = await Promise.all([
      app.request(`/api/runs/${runId}`, { headers }),
      app.request(`/api/runs/${runId}/logs`, { headers }),
      app.request(`/api/runs/${runId}/cancel`, { method: "POST", headers }),
    ]);
    return { detail: detail.status, logs: logs.status, cancel: cancel.status };
  }

  it("lists a member their own runs — manual and scheduled — and nobody else's", async () => {
    expect((await listedRuns(authHeaders(operatorA))).sort()).toEqual([runA, runAScheduled].sort());
    expect(await listedRuns(authHeaders(operatorB))).toEqual([runB]);
  });

  it("narrows the per-agent list by the same predicate", async () => {
    const res = await app.request(`/api/agents/${AGENT_PATH}/runs`, {
      headers: authHeaders(operatorA),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunList;
    expect(body.total).toBe(2);
    expect(body.data.map((r) => r.id).sort()).toEqual([runA, runAScheduled].sort());
  });

  it("narrows a schedule's run list too, though the schedule itself is readable", async () => {
    // `schedules:read` is space-wide: B reads A's schedule row. Its runs are
    // runs, so B lists none of them and the owner lists them all.
    const path = `/api/schedules/${scheduleId}/runs`;
    const asB = await app.request(path, { headers: authHeaders(operatorB) });
    expect(asB.status).toBe(200);
    expect(((await asB.json()) as RunList).data).toEqual([]);

    const asOwner = await app.request(path, { headers: authHeaders(owner) });
    expect(((await asOwner.json()) as RunList).data.map((r) => r.id)).toEqual([runAScheduled]);
  });

  it("404s detail, logs and cancel on every run a member does not own", async () => {
    for (const [label, runId] of [
      ["colleague", runB],
      ["end-user", runEndUser],
      ["actor-less", runLegacy],
    ] as const) {
      const statuses = await statusesFor(authHeaders(operatorA), runId);
      expect(`${label}: ${JSON.stringify(statuses)}`).toBe(
        `${label}: ${JSON.stringify({ detail: 404, logs: 404, cancel: 404 })}`,
      );
    }
  });

  it("serves a member their own run on all three surfaces", async () => {
    const headers = authHeaders(operatorA);
    const detail = await app.request(`/api/runs/${runA}`, { headers });
    expect(detail.status).toBe(200);
    const logs = await app.request(`/api/runs/${runA}/logs`, { headers });
    expect(logs.status).toBe(200);
    // The run is terminal, so cancel refuses on STATE (409), not on visibility.
    const cancel = await app.request(`/api/runs/${runA}/cancel`, { method: "POST", headers });
    expect(cancel.status).toBe(409);
  });

  it("gives an admin holding runs:read-all every run in the space", async () => {
    expect((await listedRuns(authHeaders(owner))).sort()).toEqual(
      [runA, runB, runAScheduled, runEndUser, runLegacy].sort(),
    );
    for (const runId of [runB, runEndUser, runLegacy]) {
      const res = await app.request(`/api/runs/${runId}`, { headers: authHeaders(owner) });
      expect(`${runId}: ${res.status}`).toBe(`${runId}: 200`);
    }
  });

  it("answers ?user=me strictly own runs, even for a caller holding read-all", async () => {
    // The owner launched none of the five: "mine" is empty, and neither the
    // end-user's run nor the actor-less row leaks in through an
    // `user_id IS NULL` arm.
    expect(await listedRuns(authHeaders(owner), "?user=me")).toEqual([]);
    expect(await listedRuns(authHeaders(operatorA), "?user=me")).toEqual(
      expect.arrayContaining([runA, runAScheduled]),
    );
    expect(await listedRuns(authHeaders(operatorA), "?user=me")).toHaveLength(2);
  });

  it("keys an API key on its own scopes, not on its creator's preset", async () => {
    const headersFor = async (scopes: string[]) => {
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: owner.defaultSpaceId,
        createdBy: owner.user.id,
        scopes,
      });
      return { Authorization: `Bearer ${key.rawKey}`, "X-Space-Id": owner.defaultSpaceId };
    };

    // The key's principal is its creator (the owner), who launched nothing.
    expect(await listedRuns(await headersFor(["runs:read"]))).toEqual([]);
    expect((await listedRuns(await headersFor(["runs:read", "runs:read-all"]))).sort()).toEqual(
      [runA, runB, runAScheduled, runEndUser, runLegacy].sort(),
    );
  });

  it("applies the persona's set under X-View-As, not the previewer's", async () => {
    // The owner reads everything; previewed as an operator they read only what
    // they launched — which, here, is nothing.
    const headers = authHeaders(owner, {
      "X-View-As": `org_role=member; space=${owner.defaultSpaceId}; role=preset:operator`,
    });
    expect(await listedRuns(headers)).toEqual([]);
    const res = await app.request(`/api/runs/${runB}`, { headers });
    expect(res.status).toBe(404);
  });

  it("leaves an end-user principal on its own run", async () => {
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: owner.defaultSpaceId,
      createdBy: owner.user.id,
      scopes: ["runs:read"],
    });
    const headers = {
      Authorization: `Bearer ${key.rawKey}`,
      "X-Space-Id": owner.defaultSpaceId,
      "Appstrate-User": endUserId,
    };
    expect(await listedRuns(headers)).toEqual([runEndUser]);
    const foreign = await app.request(`/api/runs/${runA}`, { headers });
    expect(foreign.status).toBe(404);
  });

  it("refuses rerun_from on a run the caller may not read", async () => {
    // Replaying a run hands back its persisted input, so `rerun_from` is a run
    // READ wearing a launch body. The control is the agent itself: A reads it,
    // so the 404 below is about the run and not about the route.
    const agent = await app.request(AGENT_DETAIL_PATH, { headers: authHeaders(operatorA) });
    expect(agent.status).toBe(200);

    const res = await app.request(`/api/agents/${AGENT_PATH}/run?version=draft`, {
      method: "POST",
      headers: authHeaders(operatorA, { "Content-Type": "application/json" }),
      body: JSON.stringify({ rerun_from: runB }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { detail: string }).toMatchObject({ detail: "Run not found" });
  });

  it("hides a colleague's and an end-user's run outputs from the file gallery", async () => {
    // The gallery's run-contained arm tests the same ownership on the file's
    // own columns.
    const fileA = await seedOutput(runA, { userId: operatorA.user.id });
    const fileB = await seedOutput(runB, { userId: operatorB.user.id });
    const fileEndUser = await seedOutput(runEndUser, { endUserId });

    const listed = async (ctx: TestContext) => {
      const res = await app.request("/api/files", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { id: string }[] }).data.map((f) => f.id);
    };

    expect(await listed(operatorA)).toEqual([fileA]);
    expect((await listed(owner)).sort()).toEqual([fileA, fileB, fileEndUser].sort());
  });

  it("counts only the caller's own runs in running_runs on GET /api/agents", async () => {
    await seedRun({
      packageId: AGENT_ID,
      orgId: owner.orgId,
      spaceId: owner.defaultSpaceId,
      userId: operatorB.user.id,
      status: "running",
    });
    const running = await seedRun({
      packageId: AGENT_ID,
      orgId: owner.orgId,
      spaceId: owner.defaultSpaceId,
      userId: operatorA.user.id,
      status: "running",
    });
    expect(running.id).toBeTruthy();

    const countFor = async (ctx: TestContext) => {
      const res = await app.request("/api/agents", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string; running_runs: number }[] };
      return body.data.find((a) => a.id === AGENT_ID)?.running_runs;
    };

    expect(await countFor(operatorA)).toBe(1);
    expect(await countFor(owner)).toBe(2);
  });

  it("resolves a run-contained file by id only for a caller who may read its run", async () => {
    const fileA = await seedOutput(runA, { userId: operatorA.user.id });
    const fileB = await seedOutput(runB, { userId: operatorB.user.id });
    const get = (ctx: TestContext, id: string, suffix = "") =>
      app.request(`/api/files/${id}${suffix}`, { headers: authHeaders(ctx) });

    expect((await get(operatorA, fileA)).status).toBe(200);
    expect((await get(operatorA, fileB)).status).toBe(404);
    expect((await get(owner, fileB)).status).toBe(200);

    // On `/content` both answers are a 404 — the ACL's and the one for bytes
    // this fixture never wrote — so the detail is what separates them. The
    // owner's read reaching the storage layer at all is the proof it passed
    // the ACL that stopped A.
    const denied = await get(operatorA, fileB, "/content");
    expect(denied.status).toBe(404);
    expect((await denied.json()) as { detail: string }).toMatchObject({ detail: "File not found" });
    const admin = await get(owner, fileB, "/content");
    expect((await admin.json()) as { detail: string }).toMatchObject({
      detail: "File content not found",
    });
  });

  it("refuses a colleague's run output passed as an appfile:// run input", async () => {
    const fileB = await seedOutput(runB, { userId: operatorB.user.id });
    const res = await app.request(`/api/agents/${AGENT_PATH}/run?version=draft`, {
      method: "POST",
      headers: authHeaders(operatorA, { "Content-Type": "application/json" }),
      body: JSON.stringify({ input: { attachment: `appfile://${fileB}` } }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { detail: string }).toMatchObject({
      detail: `File '${fileB}' not found`,
    });
  });

  it("takes runs:read-all as well as runs:delete to bulk-delete an agent's runs", async () => {
    // The bulk delete is the one run mutation with no row to check: it spans
    // every run of the agent in the space, so the space-wide read authorizes
    // the span. A key scoped `runs:delete` alone would erase what it cannot see.
    const headersFor = async (scopes: string[]) => {
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: owner.defaultSpaceId,
        createdBy: owner.user.id,
        scopes,
      });
      return { Authorization: `Bearer ${key.rawKey}`, "X-Space-Id": owner.defaultSpaceId };
    };
    const path = `/api/agents/${AGENT_PATH}/runs`;

    const denied = await app.request(path, {
      method: "DELETE",
      headers: await headersFor(["runs:delete"]),
    });
    expect(denied.status).toBe(403);

    const allowed = await app.request(path, {
      method: "DELETE",
      headers: await headersFor(["runs:delete", "runs:read-all"]),
    });
    expect(allowed.status).toBe(200);
    expect((await allowed.json()) as { deleted_count: number }).toMatchObject({ deleted_count: 5 });
  });

  it("reports the caller's own last_run on the agent detail", async () => {
    const detailFor = async (ctx: TestContext) => {
      const res = await app.request(AGENT_DETAIL_PATH, { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      return (await res.json()) as { last_run: { id: string } | null };
    };

    expect((await detailFor(operatorB)).last_run?.id).toBe(runB);
    // B launched exactly one run, so a leak from A or the end-user would show
    // as a different id, not merely as a different count.
    expect((await detailFor(operatorA)).last_run?.id).not.toBe(runB);
  });
});
