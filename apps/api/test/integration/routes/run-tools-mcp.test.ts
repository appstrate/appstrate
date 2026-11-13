// SPDX-License-Identifier: Apache-2.0

/**
 * The run MCP server (`services/run-tools-mcp.ts`) on its two mounts:
 * `POST /internal/mcp` (run token) and `POST /api/runs/{runId}/mcp` (the run's
 * sink signature, remote runs only).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import { notifications, packagePersistence, runLogs, runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../helpers/mcp.ts";
import { seedAgent, seedEndUser, seedRun } from "../../helpers/seed.ts";
import { addMemory, listPinnedSlots } from "../../../src/services/state/package-persistence.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";

const app = getTestApp();

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** Headers for one request, given the exact body it carries. */
type HeadersFor = Record<string, string> | ((body: string) => Record<string, string>);

async function rpc(
  path: string,
  headers: HeadersFor,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; envelope: JsonRpcEnvelope }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await app.request(path, {
    method: "POST",
    headers: {
      ...(typeof headers === "function" ? headers(body) : headers),
      "content-type": "application/json",
      Accept: MCP_ACCEPT,
    },
    body,
  });
  const text = await res.text();
  let envelope: JsonRpcEnvelope = {};
  try {
    envelope = text ? (JSON.parse(text) as JsonRpcEnvelope) : {};
  } catch {
    // A problem+json refusal from the route, not a JSON-RPC envelope.
  }
  return { status: res.status, envelope };
}

async function callTool(
  path: string,
  headers: HeadersFor,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { status, envelope } = await rpc(path, headers, "tools/call", { name, arguments: args });
  expect(status).toBe(200);
  expect(envelope.error).toBeUndefined();
  return envelope.result as unknown as ToolResult;
}

describe("run MCP server", () => {
  let ctx: TestContext;
  const pkgId = "@runtoolsorg/agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "runtoolsorg" });
    await seedAgent({ id: pkgId, orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  function seedRunningRun(overrides: Partial<Parameters<typeof seedRun>[0]> = {}) {
    return seedRun({
      packageId: pkgId,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
      ...overrides,
    });
  }

  describe("POST /internal/mcp", () => {
    const path = "/internal/mcp";
    const bearer = (runId: string) => ({ Authorization: `Bearer ${signRunToken(runId)}` });

    it("returns 401 without a run token", async () => {
      const { status } = await rpc(path, {}, "tools/list");
      expect(status).toBe(401);
    });

    it("returns 401 with a forged run token", async () => {
      const run = await seedRunningRun();
      const forged = `${run.id}.${"0".repeat(64)}`;
      const { status } = await rpc(path, { Authorization: `Bearer ${forged}` }, "tools/list");
      expect(status).toBe(401);
    });

    it("accepts a lowercase `bearer` scheme on the run token", async () => {
      const run = await seedRunningRun();
      const { status } = await rpc(
        path,
        { Authorization: `bearer ${signRunToken(run.id)}` },
        "tools/list",
      );
      expect(status).toBe(200);
    });

    it("returns 403 when the run is not running", async () => {
      const done = await seedRunningRun({ status: "success" });
      const { status } = await rpc(path, bearer(done.id), "tools/list");
      expect(status).toBe(403);
    });

    it("lists the six platform tools", async () => {
      const run = await seedRunningRun();
      const { status, envelope } = await rpc(path, bearer(run.id), "tools/list");
      expect(status).toBe(200);
      const names = (envelope.result!.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toEqual(["log", "note", "pin", "recall_memory", "run_history", "notify"]);
    });

    // The shipped manifest is the catalog an author selects from; the server is what a run
    // gets. Neither may name a tool the other does not.
    it("lists exactly the tools the shipped `@appstrate/platform` manifest declares", async () => {
      const manifest = (await Bun.file(
        new URL(
          "../../../../../scripts/system-packages/integration-platform-1.0.0/manifest.json",
          import.meta.url,
        ).pathname,
      ).json()) as { tools_policy: Record<string, unknown>; default_tools: string[] };
      const run = await seedRunningRun();
      const { envelope } = await rpc(path, bearer(run.id), "tools/list");
      const names = (envelope.result!.tools as Array<{ name: string }>).map((t) => t.name);
      expect(Object.keys(manifest.tools_policy).sort()).toEqual([...names].sort());
      // `notify` reaches people: an agent receives it by selecting it, never by default.
      expect([...manifest.default_tools].sort()).toEqual(
        names.filter((n) => n !== "notify").sort(),
      );
    });

    it("`log` appends a progress run log at call time", async () => {
      const run = await seedRunningRun();
      const result = await callTool(path, bearer(run.id), "log", {
        level: "warn",
        message: "halfway there",
      });
      expect(result.isError).toBeUndefined();
      const rows = await db.select().from(runLogs).where(eq(runLogs.runId, run.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "progress",
        event: "log",
        message: "halfway there",
        level: "warn",
      });
    });

    it("refuses arguments outside the input schema as a tool error", async () => {
      const run = await seedRunningRun();
      for (const [tool, args] of [
        ["log", { level: "loud", message: "x" }],
        ["log", { level: "info", message: "x".repeat(2001) }],
        ["note", { content: "x".repeat(2001) }],
      ] as const) {
        const result = await callTool(path, bearer(run.id), tool, args);
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain(`${tool}: invalid arguments`);
      }
      expect(await db.select().from(runLogs).where(eq(runLogs.runId, run.id))).toHaveLength(0);
      expect(
        await db.select().from(packagePersistence).where(eq(packagePersistence.runId, run.id)),
      ).toHaveLength(0);
    });

    it("refuses a JSON-RPC batch with 400 `-32600`", async () => {
      const run = await seedRunningRun();
      const message = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
      const res = await app.request(path, {
        method: "POST",
        headers: {
          ...bearer(run.id),
          "content-type": "application/json",
          Accept: MCP_ACCEPT,
        },
        body: JSON.stringify([message, { ...message, id: 2 }]),
      });
      expect(res.status).toBe(400);
      const envelope = (await res.json()) as JsonRpcEnvelope;
      expect(envelope.error?.code).toBe(-32600);
    });

    it("answers 405 with `Allow: POST` to a GET", async () => {
      const res = await app.request(path, { method: "GET", headers: { Accept: MCP_ACCEPT } });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    });

    it("`note` and `pin` persist even when the run dies before finalize", async () => {
      const run = await seedRunningRun();
      await callTool(path, bearer(run.id), "note", { content: "API paginates at 100" });
      await callTool(path, bearer(run.id), "note", { content: "team fact", scope: "shared" });
      await callTool(path, bearer(run.id), "pin", { key: "persona", content: { tone: "dry" } });
      // Killed: the run leaves `running` without any finalize body.
      await db.update(runs).set({ status: "failed" }).where(eq(runs.id, run.id));

      const rows = await db
        .select()
        .from(packagePersistence)
        .where(eq(packagePersistence.packageId, pkgId));
      const byContent = (content: unknown) =>
        rows.find((r) => JSON.stringify(r.content) === JSON.stringify(content));
      expect(byContent("API paginates at 100")).toMatchObject({
        key: null,
        pinned: false,
        actorType: "user",
        actorId: ctx.user.id,
        runId: run.id,
      });
      expect(byContent("team fact")).toMatchObject({ actorType: "shared", actorId: null });
      expect(byContent({ tone: "dry" })).toMatchObject({ key: "persona", pinned: true });
      expect(rows).toHaveLength(3);
    });

    it("`recall_memory` returns the notes written through `note`, once each", async () => {
      const run = await seedRunningRun();
      await callTool(path, bearer(run.id), "note", { content: "Gmail paginates at 100" });
      const result = await callTool(path, bearer(run.id), "recall_memory", { q: "gmail" });
      const body = JSON.parse(result.content[0]!.text) as { memories: Array<{ content: string }> };
      expect(body.memories.map((m) => m.content)).toEqual(["Gmail paginates at 100"]);
    });

    it('`pin("checkpoint")` is read back by the next run\'s `run_history`', async () => {
      const first = await seedRunningRun();
      await callTool(path, bearer(first.id), "pin", { key: "checkpoint", content: { cursor: 42 } });
      const [snapshot] = await db
        .select({ checkpoint: runs.checkpoint })
        .from(runs)
        .where(eq(runs.id, first.id));
      expect(snapshot!.checkpoint).toEqual({ cursor: 42 });
      await db.update(runs).set({ status: "success" }).where(eq(runs.id, first.id));

      const second = await seedRunningRun();
      const result = await callTool(path, bearer(second.id), "run_history", {
        fields: ["checkpoint"],
      });
      const body = JSON.parse(result.content[0]!.text) as {
        data: Array<{ id: string; checkpoint: unknown }>;
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({ id: first.id, checkpoint: { cursor: 42 } });
    });

    it("`run_history` never returns another actor's run", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        externalId: "ext_history",
      });
      await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: null,
        endUserId: eu.id,
        status: "success",
        checkpoint: { secret: true },
      });
      const run = await seedRunningRun();
      const result = await callTool(path, bearer(run.id), "run_history", {
        fields: ["checkpoint"],
      });
      const body = JSON.parse(result.content[0]!.text) as { data: unknown[] };
      expect(body.data).toEqual([]);
    });

    it("`recall_memory` never returns another actor's archive", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        externalId: "ext_recall",
      });
      const run = await seedRunningRun();
      await addMemory(
        pkgId,
        ctx.defaultSpaceId,
        ctx.orgId,
        { type: "end_user", id: eu.id },
        "secret end-user memory",
        run.id,
      );
      const result = await callTool(path, bearer(run.id), "recall_memory", {});
      const body = JSON.parse(result.content[0]!.text) as { memories: unknown[] };
      expect(body.memories).toEqual([]);
    });

    it("`run_history` excludes the current run and honours `limit` and `fields`", async () => {
      for (const [i, startedAt] of ["2026-01-01", "2026-01-02", "2026-01-03"].entries()) {
        await seedRunningRun({
          status: "success",
          startedAt: new Date(startedAt),
          checkpoint: { n: i },
          result: { output: { n: i } },
        });
      }
      const run = await seedRunningRun({ startedAt: new Date("2026-01-04") });
      const result = await callTool(path, bearer(run.id), "run_history", {
        limit: 2,
        fields: ["result"],
      });
      const body = JSON.parse(result.content[0]!.text) as {
        data: Array<Record<string, unknown>>;
      };
      expect(body.data).toHaveLength(2);
      expect(body.data.map((r) => r.id)).not.toContain(run.id);
      expect(body.data.map((r) => r.result)).toEqual([{ output: { n: 2 } }, { output: { n: 1 } }]);
      for (const entry of body.data) expect(entry).not.toHaveProperty("checkpoint");
    });

    it("`recall_memory` honours `q` and `limit`", async () => {
      const run = await seedRunningRun();
      for (const content of ["Gmail quota", "gmail pagination", "Slack rate limit"]) {
        await callTool(path, bearer(run.id), "note", { content });
      }
      const filtered = await callTool(path, bearer(run.id), "recall_memory", { q: "GMAIL" });
      const byQuery = JSON.parse(filtered.content[0]!.text) as {
        memories: Array<{ content: string }>;
      };
      expect(byQuery.memories.map((m) => m.content).sort()).toEqual([
        "Gmail quota",
        "gmail pagination",
      ]);
      const limited = await callTool(path, bearer(run.id), "recall_memory", { limit: 1 });
      const byLimit = JSON.parse(limited.content[0]!.text) as { memories: unknown[] };
      expect(byLimit.memories).toHaveLength(1);
    });

    it('`note` and `pin` with `scope: "shared"` reach another actor of the space; the default does not', async () => {
      const run = await seedRunningRun();
      await callTool(path, bearer(run.id), "note", { content: "team fact", scope: "shared" });
      await callTool(path, bearer(run.id), "note", { content: "private fact" });
      await callTool(path, bearer(run.id), "pin", {
        key: "repo",
        content: { head: "abc" },
        scope: "shared",
      });
      await callTool(path, bearer(run.id), "pin", { key: "persona", content: "dry" });

      const eu = await seedEndUser({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        externalId: "ext_shared",
      });
      const other = await seedRunningRun({ userId: null, endUserId: eu.id });
      const recalled = await callTool(path, bearer(other.id), "recall_memory", {});
      const body = JSON.parse(recalled.content[0]!.text) as {
        memories: Array<{ content: string }>;
      };
      expect(body.memories.map((m) => m.content)).toEqual(["team fact"]);
      const slots = await listPinnedSlots(pkgId, ctx.defaultSpaceId, {
        type: "end_user",
        id: eu.id,
      });
      expect(slots.map((r) => r.key)).toEqual(["repo"]);
    });

    it("`note` at the archive limit is a tool error and writes nothing", async () => {
      const run = await seedRunningRun();
      await db.insert(packagePersistence).values(
        Array.from({ length: 100 }, (_, i) => ({
          packageId: pkgId,
          spaceId: ctx.defaultSpaceId,
          orgId: ctx.orgId,
          pinned: false,
          actorType: "user" as const,
          actorId: ctx.user.id,
          content: `memory ${i}`,
          runId: run.id,
        })),
      );
      const result = await callTool(path, bearer(run.id), "note", { content: "one too many" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("archive memory limit");
      const rows = await db
        .select()
        .from(packagePersistence)
        .where(eq(packagePersistence.packageId, pkgId));
      expect(rows).toHaveLength(100);
    });

    it('`pin("checkpoint", <non-object>)` keeps the slot but does not write `runs.checkpoint`', async () => {
      const run = await seedRunningRun();
      const result = await callTool(path, bearer(run.id), "pin", {
        key: "checkpoint",
        content: "page 3",
      });
      expect(result.isError).toBeUndefined();
      const [snapshot] = await db
        .select({ checkpoint: runs.checkpoint })
        .from(runs)
        .where(eq(runs.id, run.id));
      expect(snapshot!.checkpoint).toBeNull();
      const slots = await listPinnedSlots(pkgId, ctx.defaultSpaceId);
      expect(slots.map((r) => [r.key, r.content])).toEqual([["checkpoint", "page 3"]]);
    });

    it("`pin` refuses a malformed key as a tool error, writing nothing", async () => {
      const run = await seedRunningRun();
      const result = await callTool(path, bearer(run.id), "pin", { key: "Bad Key", content: 1 });
      expect(result.isError).toBe(true);
      const rows = await db
        .select()
        .from(packagePersistence)
        .where(eq(packagePersistence.packageId, pkgId));
      expect(rows).toHaveLength(0);
    });
  });

  describe("`notify`", () => {
    const path = "/internal/mcp";
    const bearer = (runId: string) => ({ Authorization: `Bearer ${signRunToken(runId)}` });
    const notificationsOf = (runId: string) =>
      db.select().from(notifications).where(eq(notifications.runId, runId));

    it("notifies the run's trigger with an `agent_message` linked to the run", async () => {
      const run = await seedRunningRun();
      const result = await callTool(path, bearer(run.id), "notify", {
        title: "Invoices ready",
        message: "12 invoices await your review.",
      });
      expect(result.isError).toBeUndefined();
      const rows = await notificationsOf(run.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        recipientType: "user",
        recipientId: ctx.user.id,
        type: "agent_message",
        runId: run.id,
        payload: {
          packageId: pkgId,
          title: "Invoices ready",
          message: "12 invoices await your review.",
        },
        readAt: null,
      });
    });

    it("fans an unattended run's message out to the org owners and admins", async () => {
      const admin = await memberContext(ctx, "admin");
      await memberContext(ctx, "member");
      const run = await seedRunningRun({ userId: null });
      const result = await callTool(path, bearer(run.id), "notify", { title: "t", message: "m" });
      expect(result.isError).toBeUndefined();
      const recipients = (await notificationsOf(run.id)).map((r) => r.recipientId).sort();
      expect(recipients).toEqual([ctx.user.id, admin.user.id].sort());
    });

    it("refuses arguments outside the input schema as a tool error, writing nothing", async () => {
      const run = await seedRunningRun();
      for (const args of [
        { title: "only a title" },
        { title: "", message: "m" },
        { title: "t".repeat(101), message: "m" },
        { title: "t", message: "m".repeat(501) },
      ]) {
        const result = await callTool(path, bearer(run.id), "notify", args);
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("notify: invalid arguments");
      }
      expect(await notificationsOf(run.id)).toHaveLength(0);
    });

    it("refuses a run nobody can be notified for, writing nothing", async () => {
      const inlineId = `@inline/r-${crypto.randomUUID()}`;
      await seedAgent({ id: inlineId, orgId: ctx.orgId, createdBy: ctx.user.id, ephemeral: true });
      const run = await seedRunningRun({ packageId: inlineId });
      const result = await callTool(path, bearer(run.id), "notify", { title: "t", message: "m" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("nobody can be notified");
      expect(await notificationsOf(run.id)).toHaveLength(0);
    });

    it("notifies each recipient once per run: a second call is a tool error", async () => {
      const run = await seedRunningRun();
      await callTool(path, bearer(run.id), "notify", { title: "first", message: "m" });
      const second = await callTool(path, bearer(run.id), "notify", {
        title: "second",
        message: "m",
      });
      expect(second.isError).toBe(true);
      expect(second.content[0]!.text).toContain("already sent its notification");
      const rows = await notificationsOf(run.id);
      expect(rows.map((r) => (r.payload as { title: string }).title)).toEqual(["first"]);
    });
  });

  describe("POST /api/runs/{runId}/mcp", () => {
    const path = (runId: string) => `/api/runs/${runId}/mcp`;
    const SECRET = "a".repeat(43);
    const OTHER_SECRET = "b".repeat(43);

    /** Standard Webhooks headers over the exact body, as the CLI signs its `/events`. */
    const signed =
      (secret: string) =>
      (body: string): Record<string, string> => {
        const headers = sign({
          msgId: `msg_${crypto.randomUUID()}`,
          timestampSec: Math.floor(Date.now() / 1000),
          body,
          secret,
        });
        return {
          "webhook-id": headers["webhook-id"],
          "webhook-timestamp": headers["webhook-timestamp"],
          "webhook-signature": headers["webhook-signature"],
        };
      };

    function seedRemoteRun(overrides: Partial<Parameters<typeof seedRun>[0]> = {}) {
      return seedRunningRun({
        runOrigin: "remote",
        sinkSecretEncrypted: encrypt(SECRET),
        sinkExpiresAt: new Date(Date.now() + 3_600_000),
        ...overrides,
      });
    }

    it("serves a remote run whose sink secret signs the body, in the run's actor scope", async () => {
      const run = await seedRemoteRun();
      const result = await callTool(path(run.id), signed(SECRET), "log", {
        level: "info",
        message: "from the CLI",
      });
      expect(result.isError).toBeUndefined();
      const rows = await db.select().from(runLogs).where(eq(runLogs.runId, run.id));
      expect(rows.map((r) => r.message)).toEqual(["from the CLI"]);

      await callTool(path(run.id), signed(SECRET), "note", { content: "CLI fact" });
      const [memory] = await db
        .select()
        .from(packagePersistence)
        .where(eq(packagePersistence.runId, run.id));
      expect(memory).toMatchObject({ actorType: "user", actorId: ctx.user.id });
    });

    it("returns 401 without signature headers", async () => {
      const run = await seedRemoteRun();
      const { status } = await rpc(path(run.id), {}, "tools/list");
      expect(status).toBe(401);
    });

    it("returns 401 for a signature over another body", async () => {
      const run = await seedRemoteRun();
      const { status } = await rpc(path(run.id), () => signed(SECRET)("{}"), "tools/list");
      expect(status).toBe(401);
    });

    it("refuses a replayed request with 409 `message_replayed`", async () => {
      const run = await seedRemoteRun();
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      const send = (headers: Record<string, string>) =>
        app.request(path(run.id), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
          body,
        });
      const headers = signed(SECRET)(body);
      expect((await send(headers)).status).toBe(200);
      const replay = await send(headers);
      expect(replay.status).toBe(409);
      expect(((await replay.json()) as { code: string }).code).toBe("message_replayed");
    });

    it("returns 401 for another run's secret", async () => {
      const run = await seedRemoteRun();
      await seedRemoteRun({ sinkSecretEncrypted: encrypt(OTHER_SECRET) });
      const { status } = await rpc(path(run.id), signed(OTHER_SECRET), "tools/list");
      expect(status).toBe(401);
    });

    it("returns 410 once the sink is closed — a finished run", async () => {
      const run = await seedRemoteRun({ status: "success", sinkClosedAt: new Date() });
      const { status } = await rpc(path(run.id), signed(SECRET), "tools/list");
      expect(status).toBe(410);
    });

    it("returns 404 for a platform-origin run, whose sidecar serves these tools", async () => {
      const run = await seedRemoteRun({ runOrigin: "platform" });
      const { status } = await rpc(path(run.id), signed(SECRET), "tools/list");
      expect(status).toBe(404);
    });

    it("answers 405 with `Allow: POST` to a GET", async () => {
      const run = await seedRemoteRun();
      const res = await app.request(path(run.id), {
        method: "GET",
        headers: { Accept: MCP_ACCEPT },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    });
  });
});
