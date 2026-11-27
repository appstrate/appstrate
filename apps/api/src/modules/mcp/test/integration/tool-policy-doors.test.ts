// SPDX-License-Identifier: Apache-2.0

/**
 * A space's tool policy is a person's decision on the dashboard: the chat's loopback bearer and
 * the MCP endpoint's own session dispatch (`invoke_operation` re-enters the platform in-process
 * with the caller's cookie) are refused, and the four writes are not in the MCP catalog.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { spaceIntegrationToolApprovals, spaceIntegrationToolBlocks } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../test/helpers/redis.ts";
import { createTestContext, type TestContext } from "../../../../../test/helpers/auth.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { loopbackHeaders } from "../../../../../test/helpers/loopback.ts";
import { seedProxyIntegration } from "../../../../../test/helpers/credential-proxy-fixtures.ts";
import { remoteIntegrationManifest } from "../../../../../test/helpers/integration-manifests.ts";
import { snapshotTools, tool, toolFingerprint } from "../../../../../test/helpers/tool-policy.ts";
import { internalDispatchHeader } from "../../../../lib/internal-dispatch.ts";
import { getCatalog } from "../../catalog.ts";
import mcpModule from "../../index.ts";

const app = getTestApp();
await registerTestPlatformApp();

const ID = "@acme/files";
const WRITES = [
  "approveIntegrationTools",
  "revokeIntegrationToolApproval",
  "blockIntegrationTools",
  "unblockIntegrationTool",
];

describe("the tool policy writes, through every door", () => {
  let ctx: TestContext;

  const approve = (headers: Record<string, string>) =>
    app.request(`/api/integrations/${ID}/tool-policy/approvals`, {
      method: "POST",
      headers: { ...headers, "X-Space-Id": ctx.defaultSpaceId, "Content-Type": "application/json" },
      body: JSON.stringify({
        tools: [{ name: "write_file", fingerprint: toolFingerprint("write_file") }],
      }),
    });

  const nothingWritten = async () => {
    expect(await db.select().from(spaceIntegrationToolApprovals)).toHaveLength(0);
    expect(await db.select().from(spaceIntegrationToolBlocks)).toHaveLength(0);
  };

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "acme" });
    await mcpModule.events!.onOrgCreate!(ctx.orgId, ctx.user.email);
    await seedProxyIntegration(
      ctx,
      remoteIntegrationManifest({
        name: ID,
        displayName: "Files",
        tools_policy: { read_file: {} },
      }),
    );
    await snapshotTools({ orgId: ctx.orgId, packageId: ID }, [tool("write_file")]);
  });

  it("refuses the chat's loopback bearer", async () => {
    const res = await approve(
      loopbackHeaders(ctx, ctx.orgId, {
        orgRole: "owner",
        permissions: ["integrations:read", "integrations:configure"],
        spaceIds: [ctx.defaultSpaceId],
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("dashboard_session_required");
    await nothingWritten();
  });

  it("refuses the session re-entering through the MCP endpoint's in-process dispatch", async () => {
    const [name, value] = internalDispatchHeader();
    const res = await approve({ Cookie: ctx.cookie, "X-Org-Id": ctx.orgId, [name]: value });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("dashboard_session_required");
    await nothingWritten();
  });

  it("keeps the four writes out of the MCP catalog", () => {
    const operations = getCatalog().operations;
    for (const id of WRITES) expect(operations.has(id)).toBe(false);
    expect(operations.has("getIntegrationToolPolicy")).toBe(true);
  });
});
