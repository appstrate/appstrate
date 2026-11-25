// SPDX-License-Identifier: Apache-2.0
/**
 * The space tool policy routes of `/api/integrations/{packageId}/tool-policy`: reading what the
 * server listed and what the space decided, and the dashboard-only writes (approve, revoke,
 * block, unblock) with their refusals and their audit trail.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MAX_APPROVED_FINGERPRINTS_PER_TOOL } from "@appstrate/core/sidecar-types";
import { db } from "@appstrate/db/client";
import {
  auditEvents,
  spaceIntegrationToolApprovals,
  spaceIntegrationToolBlocks,
  spacePackages,
} from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { seedApiKey, seedSpace } from "../../helpers/seed.ts";
import { insertToolApprovals, tool, toolFingerprint as fp } from "../../helpers/tool-policy.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  bearerApiKeyAuth,
  seedProxyConnection,
  seedProxyIntegration,
} from "../../helpers/credential-proxy-fixtures.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { recordToolSnapshot } from "../../../src/services/integration-tool-snapshots.ts";

const ID = "@acme/files";
const BASE = `/api/integrations/${ID}/tool-policy`;
const app = getTestApp();

interface Detail {
  tool_catalog: { name: string; status: string; origin: string }[];
}
interface Problem {
  code: string;
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
    expect(((await res.json()) as Problem).code).toBe("dashboard_session_required");
    expect(await db.select().from(spaceIntegrationToolApprovals)).toHaveLength(0);
  });

  it("refuses all four writes to an API key with dashboard_session_required, changing nothing", async () => {
    await listed(tool("write_file"), tool("other_tool"));
    await approve({ name: "write_file", fingerprint: fp("write_file") });
    await send("POST", "/blocks", { tools: ["other_tool"] });
    const { rawKey } = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["integrations:read", "integrations:configure"],
    });
    const keyHeaders = {
      Authorization: `Bearer ${rawKey}`,
      "X-Org-Id": ctx.orgId,
      "X-Space-Id": ctx.defaultSpaceId,
    };
    const writes: [string, string, string, unknown?][] = [
      [
        "POST approvals",
        "POST",
        "/approvals",
        { tools: [{ name: "other_tool", fingerprint: fp("other_tool") }] },
      ],
      ["DELETE approvals/:toolName", "DELETE", "/approvals/write_file"],
      ["POST blocks", "POST", "/blocks", { tools: ["write_file"] }],
      ["DELETE blocks/:toolName", "DELETE", "/blocks/other_tool"],
    ];
    for (const [label, method, path, body] of writes) {
      const res = await send(method, path, body, keyHeaders);
      expect({ label, status: res.status, code: ((await res.json()) as Problem).code }).toEqual({
        label,
        status: 403,
        code: "dashboard_session_required",
      });
    }
    const after = await view();
    expect(after.approvals.map((a) => a.tool_name)).toEqual(["write_file"]);
    expect(after.blocks.map((b) => b.tool_name)).toEqual(["other_tool"]);
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

  const holdFingerprints = (count: number) =>
    insertToolApprovals(
      { ...ctx, spaceId: ctx.defaultSpaceId, packageId: ID },
      Array.from({ length: count }, (_, i) => ({
        toolName: "write_file",
        fingerprint: i.toString(16).padStart(64, "0"),
      })),
    );

  it("accepts the 32nd approved definition of one tool", async () => {
    await listed(tool("write_file", "live"));
    await holdFingerprints(MAX_APPROVED_FINGERPRINTS_PER_TOOL - 1);

    expect(
      (await approve({ name: "write_file", fingerprint: fp("write_file", "live") })).status,
    ).toBe(204);
    expect((await view()).approvals).toHaveLength(MAX_APPROVED_FINGERPRINTS_PER_TOOL);
  });

  it("refuses a 33rd approved definition of one tool with tool_approvals_limit", async () => {
    await listed(tool("write_file", "live"));
    await holdFingerprints(MAX_APPROVED_FINGERPRINTS_PER_TOOL);
    expect(await db.select().from(spaceIntegrationToolApprovals)).toHaveLength(32);

    const refused = await approve({ name: "write_file", fingerprint: fp("write_file", "live") });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "tool_approvals_limit",
      tools: ["write_file"],
    });
    expect(await db.select().from(spaceIntegrationToolApprovals)).toHaveLength(32);

    // Withdrawing the tool's approvals frees the room.
    expect((await send("DELETE", "/approvals/write_file")).status).toBe(204);
    expect(
      (await approve({ name: "write_file", fingerprint: fp("write_file", "live") })).status,
    ).toBe(204);
  });

  it("still accepts, at the limit, a definition already among the approved ones", async () => {
    await listed(tool("write_file", "live"));
    await holdFingerprints(MAX_APPROVED_FINGERPRINTS_PER_TOOL - 1);
    expect(
      (await approve({ name: "write_file", fingerprint: fp("write_file", "live") })).status,
    ).toBe(204);
    expect(await db.select().from(spaceIntegrationToolApprovals)).toHaveLength(32);

    expect(
      (await approve({ name: "write_file", fingerprint: fp("write_file", "live") })).status,
    ).toBe(204);
    expect(await db.select().from(spaceIntegrationToolApprovals)).toHaveLength(32);
  });

  it("blocks a tool, declared or not, and lifts the block", async () => {
    await listed(tool("read_file"));
    expect((await send("POST", "/blocks", { tools: ["read_file", "read_file"] })).status).toBe(204);
    expect(await catalogEntry("read_file")).toMatchObject({ status: "blocked" });
    expect((await view()).blocks).toHaveLength(1);

    expect((await send("DELETE", "/blocks/read_file")).status).toBe(204);
    expect(await catalogEntry("read_file")).toMatchObject({ status: "available" });
  });

  it("rejects an empty or over-long tool name", async () => {
    for (const name of ["", "x".repeat(257)]) {
      const res = await send("POST", "/blocks", { tools: [name] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Problem).code).toBe("validation_failed");
    }
    expect(await db.select().from(spaceIntegrationToolBlocks)).toHaveLength(0);
  });

  it("approves and blocks any listed name: a colon, 200 characters", async () => {
    const colon = "ns:do_thing";
    const long = "t".repeat(200);
    await listed(tool(colon), tool(long));

    expect((await approve({ name: colon, fingerprint: fp(colon) })).status).toBe(204);
    expect((await send("POST", "/blocks", { tools: [long] })).status).toBe(204);

    const body = await view();
    expect(body.approvals.map((a) => a.tool_name)).toEqual([colon]);
    expect(body.blocks.map((b) => b.tool_name)).toEqual([long]);
    expect((await send("DELETE", `/blocks/${long}`)).status).toBe(204);
    expect((await send("DELETE", `/approvals/${encodeURIComponent(colon)}`)).status).toBe(204);
    expect((await view()).approvals).toHaveLength(0);
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
    const [blockedEvent] = await db
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.action, "integration.tool.blocked"));
    expect(blockedEvent!.after).toEqual({ toolName: "a_tool" });
  });

  it("audits every approval a revoke removes, with its fingerprint", async () => {
    await listed(tool("write_file", "Writes"));
    await approve({ name: "write_file", fingerprint: fp("write_file", "Writes") });
    await listed(tool("write_file", "Writes, v2"));
    await approve({ name: "write_file", fingerprint: fp("write_file", "Writes, v2") });
    await send("DELETE", "/approvals/write_file");

    const rows = await db
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.action, "integration.tool.approval_revoked"));
    expect(
      rows.map((r) => r.after).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual(
      [
        { toolName: "write_file", fingerprint: fp("write_file", "Writes") },
        { toolName: "write_file", fingerprint: fp("write_file", "Writes, v2") },
      ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  });

  it("refuses a definition too large to have been kept, with tool_definition_unavailable", async () => {
    const tools = Array.from({ length: 400 }, (_, i) => tool(`t${i}`, "x".repeat(2000)));
    await listed(...tools);
    const last = (await view()).listed.find((t) => t.definition === null)!;
    expect(last).toBeDefined();
    const res = await approve({ name: last.name, fingerprint: last.fingerprint });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "tool_definition_unavailable",
      tools: [last.name],
    });
    expect(await db.select().from(spaceIntegrationToolApprovals)).toHaveLength(0);
  });

  it("refuses to approve a hidden tool, and any tool of an open catalog", async () => {
    const hiddenId = "@acme/hidden";
    await seedProxyIntegration(ctx, {
      ...remoteIntegrationManifest({ name: hiddenId, displayName: "Hidden", tools_policy: {} }),
      hidden_tools: ["secret_tool"],
    } as never);
    const openId = "@acme/open";
    await seedProxyIntegration(ctx, {
      ...remoteIntegrationManifest({ name: openId, displayName: "Open", tools_policy: {} }),
      allow_undeclared_tools: true,
    } as never);
    for (const id of [hiddenId, openId]) {
      await recordToolSnapshot({
        orgId: ctx.orgId,
        packageId: id,
        connectionId: null,
        tools: [tool("secret_tool")],
        truncated: false,
      });
      const res = await app.request(`/api/integrations/${id}/tool-policy/approvals`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ tools: [{ name: "secret_tool", fingerprint: fp("secret_tool") }] }),
      });
      expect({
        id,
        status: res.status,
        code: ((await res.json()) as { code: string }).code,
      }).toEqual({
        id,
        status: 400,
        code: "invalid_request",
      });
    }
  });

  describe("isolation", () => {
    it("keeps an approval and a block of one space out of another space of the org", async () => {
      await listed(tool("read_file"), tool("write_file"));
      await approve({ name: "write_file", fingerprint: fp("write_file") });
      await send("POST", "/blocks", { tools: ["read_file"] });

      const spaceB = await seedSpace({ orgId: ctx.orgId, name: "Team B" });
      await db.insert(spacePackages).values({ enabled: true, spaceId: spaceB.id, packageId: ID });
      const inB = authHeaders(ctx, { "X-Space-Id": spaceB.id });

      const res = await send("GET", "", undefined, inB);
      expect(res.status).toBe(200);
      const body = (await res.json()) as View;
      expect(body.approvals).toEqual([]);
      expect(body.blocks).toEqual([]);
      // The listing is the server's: org-wide, so B still sees what it could review.
      expect(body.listed.map((t) => t.name).sort()).toEqual(["read_file", "write_file"]);

      const detail = await app.request(`/api/integrations/${ID}`, { headers: inB });
      const catalog = ((await detail.json()) as Detail).tool_catalog;
      expect(catalog.find((t) => t.name === "write_file")).toMatchObject({
        status: "pending",
        origin: "listed",
      });
      expect(catalog.find((t) => t.name === "read_file")).toMatchObject({ status: "available" });

      // And A keeps its own decisions.
      const inA = await view();
      expect(inA.approvals.map((a) => a.tool_name)).toEqual(["write_file"]);
      expect(inA.blocks.map((b) => b.tool_name)).toEqual(["read_file"]);
    });

    it("answers a caller of another organization with a 404 and writes nothing", async () => {
      await listed(tool("write_file"));
      await approve({ name: "write_file", fingerprint: fp("write_file") });
      const other = await createTestContext({ orgSlug: "other" });

      const read = await send("GET", "", undefined, authHeaders(other));
      expect(read.status).toBe(404);

      const attempts: [string, string, unknown?][] = [
        ["POST", "/approvals", { tools: [{ name: "write_file", fingerprint: fp("write_file") }] }],
        ["DELETE", "/approvals/write_file"],
        ["POST", "/blocks", { tools: ["write_file"] }],
        ["DELETE", "/blocks/write_file"],
      ];
      for (const [method, path, body] of attempts) {
        const res = await send(method, path, body, authHeaders(other));
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
      }
      const after = await view();
      expect(after.approvals.map((a) => a.tool_name)).toEqual(["write_file"]);
      expect(after.blocks).toEqual([]);
    });

    it("refuses an outsider naming organization A in X-Org-Id", async () => {
      await listed(tool("write_file"));
      const other = await createTestContext({ orgSlug: "other" });
      const res = await send("GET", "", undefined, {
        Cookie: other.cookie,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
      });
      expect(res.status).toBe(403);
      const post = await send(
        "POST",
        "/blocks",
        { tools: ["write_file"] },
        {
          Cookie: other.cookie,
          "X-Org-Id": ctx.orgId,
          "X-Space-Id": ctx.defaultSpaceId,
        },
      );
      expect(post.status).toBe(403);
      expect(await db.select().from(spaceIntegrationToolBlocks)).toHaveLength(0);
    });

    it("keeps the tools a connection listed from a colleague who cannot use that connection", async () => {
      const authedId = "@acme/authed";
      await seedProxyIntegration(
        ctx,
        remoteIntegrationManifest({
          name: authedId,
          displayName: "Authed",
          url: "https://mcp.example.com/authed",
          tools_policy: { read_file: {} },
          auths: { api_key: bearerApiKeyAuth(["https://mcp.example.com/**"]) },
        }),
      );
      const connectionId = await seedProxyConnection(ctx, authedId, "api_key", { token: "t" });
      await recordToolSnapshot({
        orgId: ctx.orgId,
        packageId: authedId,
        connectionId,
        tools: [tool("read_file"), tool("private_tool")],
        truncated: false,
      });
      const policy = (who: TestContext) =>
        app.request(`/api/integrations/${authedId}/tool-policy`, { headers: authHeaders(who) });
      const catalog = async (who: TestContext) => {
        const res = await app.request(`/api/integrations/${authedId}`, {
          headers: authHeaders(who),
        });
        expect(res.status).toBe(200);
        return ((await res.json()) as Detail).tool_catalog.map((t) => t.name);
      };

      const owner = (await (await policy(ctx)).json()) as View;
      expect(owner.listed.map((t) => t.name).sort()).toEqual(["private_tool", "read_file"]);
      expect(await catalog(ctx)).toContain("private_tool");

      const colleague = await memberContext(ctx, "member", "viewer");
      const res = await policy(colleague);
      expect(res.status).toBe(200);
      expect(((await res.json()) as View).listed).toEqual([]);
      expect(await catalog(colleague)).not.toContain("private_tool");
    });
  });
});
