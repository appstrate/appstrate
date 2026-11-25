// SPDX-License-Identifier: Apache-2.0
/**
 * The space tool policy routes of `/api/integrations/{packageId}/tool-policy`: reading what the
 * server listed and what the space decided, and the dashboard-only writes (approve, revoke,
 * block, unblock) with their refusals and their audit trail.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitionFingerprint } from "@appstrate/mcp-transport";
import { db } from "@appstrate/db/client";
import { auditEvents, spaceIntegrationToolApprovals } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedProxyIntegration } from "../../helpers/credential-proxy-fixtures.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { recordToolSnapshot } from "../../../src/services/integration-tool-snapshots.ts";

const ID = "@acme/files";
const BASE = `/api/integrations/${ID}/tool-policy`;
const app = getTestApp();

const tool = (name: string, description = `Tool ${name}`): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});
const fp = (name: string, description?: string) =>
  toolDefinitionFingerprint(tool(name, description));

interface Detail {
  tool_catalog: { name: string; status: string; origin: string }[];
}
interface View {
  listed: { name: string; fingerprint: string; definition: Record<string, unknown> | null }[];
  approvals: { tool_name: string; fingerprint: string; definition: object }[];
  blocks: { tool_name: string }[];
}

describe("integration tool policy routes", () => {
  let ctx: TestContext;

  const send = (method: string, path: string, body?: unknown, headers = authHeaders(ctx)) =>
    app.request(`${BASE}${path}`, {
      method,
      headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const view = async () => (await (await send("GET", "")).json()) as View;
  const catalogEntry = async (name: string) => {
    const res = await app.request(`/api/integrations/${ID}`, { headers: authHeaders(ctx) });
    return ((await res.json()) as Detail).tool_catalog.find((t) => t.name === name);
  };
  const listed = (...tools: Tool[]) =>
    recordToolSnapshot({
      orgId: ctx.orgId,
      packageId: ID,
      connectionId: null,
      tools,
      truncated: false,
    });
  const approve = (...tools: { name: string; fingerprint: string }[]) =>
    send("POST", "/approvals", { tools });
  const auditActions = async () =>
    (await db.select({ action: auditEvents.action }).from(auditEvents))
      .map((r) => r.action)
      .filter((a) => a.startsWith("integration.tool."));

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "acme" });
    await seedProxyIntegration(
      ctx,
      remoteIntegrationManifest({
        name: ID,
        displayName: "Files",
        url: "https://mcp.example.com/mcp",
        tools_policy: { read_file: {} },
      }),
    );
  });

  it("answers what was listed, with definitions, and what the space decided", async () => {
    await listed(tool("read_file"), tool("write_file"));
    await approve({ name: "write_file", fingerprint: fp("write_file") });
    await send("POST", "/blocks", { tools: ["read_file"] });

    const body = await view();
    expect(body.listed.map((t) => t.name).sort()).toEqual(["read_file", "write_file"]);
    expect(body.listed.find((t) => t.name === "write_file")).toMatchObject({
      fingerprint: fp("write_file"),
      definition: { name: "write_file", description: "Tool write_file" },
    });
    expect(body.approvals).toEqual([
      expect.objectContaining({ tool_name: "write_file", fingerprint: fp("write_file") }),
    ]);
    expect(body.blocks).toEqual([expect.objectContaining({ tool_name: "read_file" })]);
  });

  it("refuses an API key with dashboard_session_required, even holding configure", async () => {
    await listed(tool("write_file"));
    const { rawKey } = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["integrations:read", "integrations:configure"],
    });
    const res = await send(
      "POST",
      "/approvals",
      { tools: [{ name: "write_file", fingerprint: fp("write_file") }] },
      {
        Authorization: `Bearer ${rawKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
      },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("dashboard_session_required");
    expect(await db.select().from(spaceIntegrationToolApprovals)).toHaveLength(0);
  });

  it("refuses a session without integrations:configure", async () => {
    await listed(tool("write_file"));
    const viewer = await memberContext(ctx, "member", "viewer");
    const res = await send("POST", "/blocks", { tools: ["write_file"] }, authHeaders(viewer));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("forbidden");
  });

  it("refuses a fingerprint the server no longer lists with tool_snapshot_stale", async () => {
    await listed(tool("write_file", "Writes"));
    const res = await approve({
      name: "write_file",
      fingerprint: fp("write_file", "Writes, and mails"),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "tool_snapshot_stale", tools: ["write_file"] });
    expect(await db.select().from(spaceIntegrationToolApprovals)).toHaveLength(0);
  });

  it("refuses to approve a tool the manifest declares", async () => {
    await listed(tool("read_file"));
    const res = await approve({ name: "read_file", fingerprint: fp("read_file") });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "tool_already_declared", tools: ["read_file"] });
  });

  it("makes an approved undeclared tool available with origin approved", async () => {
    await listed(tool("read_file"), tool("write_file"));
    expect(await catalogEntry("write_file")).toMatchObject({ status: "pending", origin: "listed" });

    expect((await approve({ name: "write_file", fingerprint: fp("write_file") })).status).toBe(204);
    expect(await catalogEntry("write_file")).toMatchObject({
      status: "available",
      origin: "approved",
    });
  });

  it("keeps every approved fingerprint of a tool, and revoke removes them all", async () => {
    await listed(tool("write_file", "Writes"));
    await approve({ name: "write_file", fingerprint: fp("write_file", "Writes") });
    await listed(tool("write_file", "Writes, v2"));
    await approve({ name: "write_file", fingerprint: fp("write_file", "Writes, v2") });
    // The first definition is no longer listed, yet its approval was not deleted by the second.
    expect((await view()).approvals.map((a) => a.fingerprint).sort()).toEqual(
      [fp("write_file", "Writes"), fp("write_file", "Writes, v2")].sort(),
    );

    expect((await send("DELETE", "/approvals/write_file")).status).toBe(204);
    expect((await view()).approvals).toEqual([]);
    expect((await send("DELETE", "/approvals/write_file")).status).toBe(204);
  });

  it("blocks a tool, declared or not, and lifts the block", async () => {
    await listed(tool("read_file"));
    expect((await send("POST", "/blocks", { tools: ["read_file", "read_file"] })).status).toBe(204);
    expect(await catalogEntry("read_file")).toMatchObject({ status: "blocked" });
    expect((await view()).blocks).toHaveLength(1);

    expect((await send("DELETE", "/blocks/read_file")).status).toBe(204);
    expect(await catalogEntry("read_file")).toMatchObject({ status: "available" });
  });

  it("rejects a malformed tool name", async () => {
    const res = await send("POST", "/blocks", { tools: ["not a name!"] });
    expect(res.status).toBe(400);
  });

  it("audits each decision, one event per tool", async () => {
    await listed(tool("a_tool"), tool("b_tool"));
    await approve(
      { name: "a_tool", fingerprint: fp("a_tool") },
      { name: "b_tool", fingerprint: fp("b_tool") },
    );
    await send("DELETE", "/approvals/a_tool");
    await send("POST", "/blocks", { tools: ["a_tool"] });
    await send("DELETE", "/blocks/a_tool");

    expect((await auditActions()).sort()).toEqual([
      "integration.tool.approval_revoked",
      "integration.tool.approved",
      "integration.tool.approved",
      "integration.tool.blocked",
      "integration.tool.unblocked",
    ]);
    const [approved] = await db
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.action, "integration.tool.blocked"));
    expect(approved!.after).toEqual({ toolName: "a_tool" });
  });
});
