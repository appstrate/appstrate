// SPDX-License-Identifier: Apache-2.0
/**
 * `tool_catalog` and `tool_snapshot` of `GET /api/integrations/{packageId}`: the declared catalog
 * judged against what the server last listed and what the space approved or blocked.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitionFingerprint } from "@appstrate/mcp-transport";
import { db } from "@appstrate/db/client";
import { spaceIntegrationToolApprovals, spaceIntegrationToolBlocks } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedProxyIntegration } from "../../helpers/credential-proxy-fixtures.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { recordToolSnapshot } from "../../../src/services/integration-tool-snapshots.ts";

const ID = "@acme/files";
const app = getTestApp();

const tool = (name: string, description = `Tool ${name}`): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

interface Detail {
  tool_catalog: {
    name: string;
    status: string;
    origin: string;
    modified: boolean;
  }[];
  tool_snapshot: {
    connection_id: string | null;
    truncated: boolean;
    added: number;
    missing: number;
    modified: number;
  } | null;
}

describe("integration detail tool catalog", () => {
  let ctx: TestContext;

  const detail = async (): Promise<Detail> => {
    const res = await app.request(`/api/integrations/${ID}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    return (await res.json()) as Detail;
  };
  const entry = (body: Detail, name: string) => body.tool_catalog.find((t) => t.name === name)!;
  const listed = (...tools: Tool[]) =>
    recordToolSnapshot({
      orgId: ctx.orgId,
      packageId: ID,
      connectionId: null,
      tools,
      truncated: false,
    });

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

  it("keeps the declared catalog available when nothing was ever listed", async () => {
    const body = await detail();
    expect(body.tool_snapshot).toBeNull();
    expect(body.tool_catalog).toEqual([
      expect.objectContaining({ name: "read_file", status: "available", origin: "declared" }),
    ]);
  });

  it("holds an undeclared tool the server lists as pending on a closed catalog", async () => {
    await listed(tool("read_file"), tool("write_file"));
    const body = await detail();
    expect(entry(body, "read_file")).toMatchObject({ status: "available", modified: false });
    expect(entry(body, "write_file")).toMatchObject({
      status: "pending",
      origin: "listed",
    });
    expect(body.tool_snapshot).toMatchObject({ connection_id: null, added: 1, missing: 0 });
  });

  it("signals a declared tool whose definition changed without holding it", async () => {
    await listed(tool("read_file"));
    await listed(tool("read_file", "Reads a file, differently"));
    const body = await detail();
    expect(entry(body, "read_file")).toMatchObject({ status: "available", modified: true });
    expect(body.tool_snapshot).toMatchObject({ modified: 1 });
  });

  it("marks a declared tool the server stopped listing as missing", async () => {
    await listed(tool("other"));
    const body = await detail();
    expect(entry(body, "read_file").status).toBe("missing");
    expect(body.tool_snapshot).toMatchObject({ missing: 1 });
  });

  it("lists an approved tool as available, then pending and modified once its definition moved", async () => {
    await listed(tool("read_file"), tool("write_file"));
    await db.insert(spaceIntegrationToolApprovals).values({
      spaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      packageId: ID,
      toolName: "write_file",
      fingerprint: toolDefinitionFingerprint(tool("write_file")),
      definition: {},
    });
    expect(entry(await detail(), "write_file")).toMatchObject({
      status: "available",
      origin: "approved",
    });

    await listed(tool("read_file"), tool("write_file", "Writes, and more"));
    expect(entry(await detail(), "write_file")).toMatchObject({
      status: "pending",
      origin: "approved",
      modified: true,
    });
  });

  it("shows a blocked tool as blocked, declared or not", async () => {
    await db.insert(spaceIntegrationToolBlocks).values({
      spaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      packageId: ID,
      toolName: "read_file",
    });
    expect(entry(await detail(), "read_file").status).toBe("blocked");
  });
});
