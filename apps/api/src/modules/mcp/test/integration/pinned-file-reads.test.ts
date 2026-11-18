// SPDX-License-Identifier: Apache-2.0

/**
 * The space-pinned endpoint (`/api/mcp/o/:org/s/:space`) confines every door of the request,
 * the file readers included: a session or an organization-bound token on it reads files of that
 * space alone, as `invoke_operation` (a pinned dispatch) does. The organization endpoint reads a
 * file in its own space under the caller's set there.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../test/helpers/redis.ts";
import { createTestContext, type TestContext } from "../../../../../test/helpers/auth.ts";
import { seedSpace } from "../../../../../test/helpers/seed.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { createFileFromStream } from "../../../../services/files.ts";
import { ensurePersonalSpaceFor } from "../../../../services/spaces.ts";
import { getMcpOrgResourceUri } from "../../../../lib/audiences.ts";
import { overrideJwks } from "../../../oidc/services/enduser-token.ts";
import { resetOidcGuardsLimiters } from "../../../oidc/auth/guards.ts";
import { authorizationCodeFlow } from "../../../oidc/test/helpers/authorization-code-flow.ts";
import mcpModule from "../../index.ts";

const app = getTestApp();
await registerTestPlatformApp();

const REDIRECT_URI = "http://localhost:9919/callback";

describe("file reads on the space-pinned MCP endpoint", () => {
  let ctx: TestContext;
  let pinned: string;
  let other: string;

  async function mintOrgToken(): Promise<string> {
    const registered = await app.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "MCP client (pinned file reads)",
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
    return String(token.access_token);
  }

  /** A run output of the owner's in `spaceId`, readable by them. */
  async function fileIn(spaceId: string, content: string): Promise<string> {
    const runId = `run_${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: runId,
      orgId: ctx.orgId,
      spaceId,
      status: "success",
      userId: ctx.user.id,
    });
    const { row } = await createFileFromStream(
      { orgId: ctx.orgId, spaceId },
      runId,
      { userId: ctx.user.id, endUserId: null },
      null,
      { name: "note.txt", mime: "text/plain", body: new Blob([content]).stream() },
    );
    return `appfile://${row.id}`;
  }

  async function read(
    endpoint: string,
    headers: Record<string, string>,
    uri: string,
    spaceId?: string,
  ): Promise<{ tool: string; resource: JsonRpcEnvelope }> {
    const post = async (message: Record<string, unknown>) => {
      const res = await app.request(endpoint, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
        body: JSON.stringify(message),
      });
      return JSON.parse(await res.text()) as JsonRpcEnvelope;
    };
    const tool = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_file", arguments: { uri, ...(spaceId ? { space_id: spaceId } : {}) } },
    });
    const resource = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri },
    });
    return { tool: JSON.stringify(tool.result?.content), resource };
  }

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwks(null);
    ctx = await createTestContext({ orgSlug: "mcppinnedfiles" });
    await mcpModule.events!.onOrgCreate!(ctx.orgId, ctx.user.email);
    pinned = (await seedSpace({ orgId: ctx.orgId, name: "Épinglé" })).id;
    other = (await seedSpace({ orgId: ctx.orgId, name: "Autre" })).id;
  });

  it("reads files of the pinned space only, for a session and an organization-bound token", async () => {
    const here = await fileIn(pinned, "ici");
    const elsewhere = await fileIn(other, "ailleurs");
    const personal = await fileIn(
      (await ensurePersonalSpaceFor(ctx.orgId, ctx.user.id)).id,
      "perso",
    );
    const endpoint = `/api/mcp/o/${ctx.orgId}/s/${pinned}`;
    const credentials: Record<string, string>[] = [
      { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      { Authorization: `Bearer ${await mintOrgToken()}` },
    ];
    for (const headers of credentials) {
      const allowed = await read(endpoint, headers, here);
      expect(allowed.tool).toContain("ici");
      for (const uri of [elsewhere, personal]) {
        const refused = await read(endpoint, headers, uri);
        expect(refused.tool).toContain("not_found");
        expect(refused.tool).not.toMatch(/ailleurs|perso/);
        expect(refused.resource.error?.message).toContain("File not found");
      }
    }

    // The organization endpoint reads each in its own space, under the caller's set there.
    const orgWide = await read(
      `/api/mcp/o/${ctx.orgId}`,
      { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      elsewhere,
      pinned,
    );
    expect(orgWide.tool).toContain("ailleurs");
  });
});
