// SPDX-License-Identifier: Apache-2.0
/**
 * `tool_catalog` and `tool_snapshot` of `GET /api/integrations/{packageId}`: the declared catalog
 * judged against what the server last listed and what the space approved or blocked.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { tool } from "../../helpers/tool-policy.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedProxyIntegration } from "../../helpers/credential-proxy-fixtures.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { recordToolSnapshot } from "../../../src/services/integration-tool-snapshots.ts";

const ID = "@acme/files";
const app = getTestApp();

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
        tools_policy: { read_file: {}, gone: {} },
      }),
    );
  });

  it("keeps the declared catalog available when nothing was ever listed", async () => {
    const body = await detail();
    expect(body.tool_snapshot).toBeNull();
    expect(body.tool_catalog.map((t) => [t.name, t.status, t.origin]).sort()).toEqual([
      ["gone", "available", "declared"],
      ["read_file", "available", "declared"],
    ]);
  });

  it("judges the declared catalog against what the server listed, counting added, missing and modified", async () => {
    await listed(tool("read_file"), tool("write_file"));
    await listed(tool("read_file", "Reads a file, differently"), tool("write_file"));
    const body = await detail();

    expect(entry(body, "read_file")).toMatchObject({ status: "available", modified: true });
    expect(entry(body, "write_file")).toMatchObject({ status: "pending", origin: "listed" });
    expect(entry(body, "gone")).toMatchObject({ status: "missing", origin: "declared" });
    expect(body.tool_snapshot).toMatchObject({
      connection_id: null,
      added: 1,
      missing: 1,
      modified: 1,
    });
  });
});
