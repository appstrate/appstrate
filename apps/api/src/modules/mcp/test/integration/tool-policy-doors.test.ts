// SPDX-License-Identifier: Apache-2.0

/**
 * A space's tool policy is a person's decision on the dashboard: the chat's loopback bearer, a
 * minted MCP instance token and the MCP endpoint's own session dispatch (`invoke_operation`
 * re-enters the platform in-process with the caller's cookie) are all refused, and the four
 * writes are not in the MCP catalog.
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
import { tool, toolFingerprint } from "../../../../../test/helpers/tool-policy.ts";
import { getMcpOrgResourceUri } from "../../../../lib/audiences.ts";
import { internalDispatchHeader } from "../../../../lib/internal-dispatch.ts";
import { recordToolSnapshot } from "../../../../services/integration-tool-snapshots.ts";
import { resetOidcGuardsLimiters } from "../../../oidc/auth/guards.ts";
import { overrideJwks } from "../../../oidc/services/enduser-token.ts";
import { authorizationCodeFlow } from "../../../oidc/test/helpers/authorization-code-flow.ts";
import { getCatalog } from "../../catalog.ts";
import mcpModule from "../../index.ts";

const app = getTestApp();
await registerTestPlatformApp();

const ID = "@acme/files";
const REDIRECT_URI = "http://localhost:9919/callback";
const WRITES = [
  "approveIntegrationTools",
  "revokeIntegrationToolApproval",
  "blockIntegrationTools",
  "unblockIntegrationTool",
];

describe("the tool policy writes, through every door", () => {
  let ctx: TestContext;

  async function mintOrgToken(): Promise<string> {
    const registered = await app.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "MCP client (tool policy)",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const { token } = await authorizationCodeFlow(app, {
      cookie: ctx.cookie,
      clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid mcp:read mcp:invoke",
      resource: getMcpOrgResourceUri(ctx.orgId),
    });
    return `Bearer ${String(token.access_token)}`;
  }

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
    resetOidcGuardsLimiters();
    overrideJwks(null);
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
    await recordToolSnapshot({
      orgId: ctx.orgId,
      packageId: ID,
      connectionId: null,
      tools: [tool("write_file")],
      truncated: false,
    });
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

  it("refuses a minted MCP instance token", async () => {
    const res = await approve({ Authorization: await mintOrgToken(), "X-Org-Id": ctx.orgId });
    // Bound to the MCP resource, the token never reaches the route's dashboard-session guard:
    // the REST pipeline answers 401 first, which is the exact refusal a minted token meets.
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      code: "unauthorized",
      detail: "Access token is bound to a different resource and cannot be used on this route.",
    });
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
