// SPDX-License-Identifier: Apache-2.0

/**
 * The run MCP server (`services/run-tools-mcp.ts`) on its two mounts:
 * `POST /internal/mcp` (run token) and `POST /api/runs/{runId}/mcp` (standard
 * auth, remote run the caller launched).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { notifications, packagePersistence, runLogs, runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  memberHolding,
  type TestContext,
} from "../../helpers/auth.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../helpers/mcp.ts";
import { seedAgent, seedEndUser, seedRun } from "../../helpers/seed.ts";
import { addMemories } from "../../../src/services/state/package-persistence.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";

const app = getTestApp();

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function rpc(
  path: string,
  headers: Record<string, string>,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; envelope: JsonRpcEnvelope }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
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
  headers: Record<string, string>,
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
      const result = await callTool(path, bearer(run.id), "log", { level: "loud", message: "x" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("log: invalid arguments");
      expect(await db.select().from(runLogs).where(eq(runLogs.runId, run.id))).toHaveLength(0);
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

    it("`note` stores a memory whose trim splits a surrogate pair, the half replaced", async () => {
      const run = await seedRunningRun();
      await callTool(path, bearer(run.id), "note", { content: `${"a".repeat(1999)}😀` });

      const rows = await db
        .select()
        .from(packagePersistence)
        .where(eq(packagePersistence.runId, run.id));
      expect(rows.map((r) => r.content)).toEqual([`${"a".repeat(1999)}\uFFFD`]);
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
      await addMemories(
        pkgId,
        ctx.defaultSpaceId,
        ctx.orgId,
        { type: "end_user", id: eu.id },
        ["secret end-user memory"],
        run.id,
      );
      const result = await callTool(path, bearer(run.id), "recall_memory", {});
      const body = JSON.parse(result.content[0]!.text) as { memories: unknown[] };
      expect(body.memories).toEqual([]);
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

    it("serves a running remote run the caller launched", async () => {
      const run = await seedRunningRun({ runOrigin: "remote" });
      const result = await callTool(path(run.id), authHeaders(ctx), "log", {
        level: "info",
        message: "from the CLI",
      });
      expect(result.isError).toBeUndefined();
      const rows = await db.select().from(runLogs).where(eq(runLogs.runId, run.id));
      expect(rows.map((r) => r.message)).toEqual(["from the CLI"]);
    });

    it("returns 401 without credentials", async () => {
      const run = await seedRunningRun({ runOrigin: "remote" });
      const { status } = await rpc(path(run.id), {}, "tools/list");
      expect(status).toBe(401);
    });

    it("returns 403 without `agents:run`", async () => {
      const reader = await memberHolding(ctx, ["runs:read"]);
      const run = await seedRunningRun({ runOrigin: "remote", userId: reader.user.id });
      const { status } = await rpc(path(run.id), authHeaders(reader), "tools/list");
      expect(status).toBe(403);
    });

    it("returns 403 when the run is not running", async () => {
      const run = await seedRunningRun({ runOrigin: "remote", status: "success" });
      const { status } = await rpc(path(run.id), authHeaders(ctx), "tools/list");
      expect(status).toBe(403);
    });

    it("returns 404 for another member's run, even to an owner who reads every run", async () => {
      const colleague = await memberContext(ctx, "admin");
      const run = await seedRunningRun({ runOrigin: "remote", userId: colleague.user.id });
      const { status } = await rpc(path(run.id), authHeaders(ctx), "tools/list");
      expect(status).toBe(404);
    });

    it("returns 404 for a platform-origin run", async () => {
      const run = await seedRunningRun({ runOrigin: "platform" });
      const { status } = await rpc(path(run.id), authHeaders(ctx), "tools/list");
      expect(status).toBe(404);
    });
  });
});
