// SPDX-License-Identifier: Apache-2.0

/**
 * An external MCP client (Claude Code, claude.ai, Codex) registers itself and
 * gets an instance token audience-bound to ONE organization's MCP endpoint: the
 * person's identity, no scope ceiling. Its `memory` tool keeps the boundary
 * between organizations; the `/api/me/memories` routes, reachable from it only
 * through `invoke_operation`, must refuse it, or it would read and write the
 * memories of every other organization. One rule for both: the credential is
 * bound to the organization, so it reaches what is about the person and that one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as jose from "jose";
import { _resetCacheForTesting } from "@appstrate/env";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  createTestOrg,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { MCP_ACCEPT } from "../../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../../test/helpers/platform-app.ts";

const originalAppUrl = process.env.APP_URL;
let jwksServer: ReturnType<typeof Bun.serve> | null = null;
let privateKey: jose.CryptoKey;
let publicJwk: jose.JWK;
const kid = "memory-mcp-client-key";
let app: Awaited<ReturnType<typeof import("../../../../../../test/helpers/app.ts").getTestApp>>;

beforeAll(async () => {
  const { publicKey, privateKey: priv } = await jose.generateKeyPair("ES256", {
    extractable: true,
  });
  privateKey = priv;
  publicJwk = { ...(await jose.exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  jwksServer = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/api/auth/jwks"
        ? Response.json({ keys: [publicJwk] })
        : new Response("not found", { status: 404 }),
  });
  process.env.APP_URL = `http://127.0.0.1:${jwksServer.port}`;
  _resetCacheForTesting();
  const { getTestApp } = await import("../../../../../../test/helpers/app.ts");
  const { default: oidcModule } = await import("../../../index.ts");
  const { default: mcpModule } = await import("../../../../mcp/index.ts");
  const { overrideJwks } = await import("../../../services/enduser-token.ts");
  overrideJwks(async () => ({ keys: [publicJwk] }));
  app = getTestApp({ modules: [oidcModule, mcpModule] });
  await registerTestPlatformApp();
});

afterAll(() => {
  jwksServer?.stop(true);
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
  _resetCacheForTesting();
});

async function mcpToken(sub: string, clientId: string, orgId: string): Promise<string> {
  const { getMcpOrgResourceUri } = await import("../../../../../lib/audiences.ts");
  return new jose.SignJWT({
    azp: clientId,
    actor_type: "user",
    email: "mcp@example.com",
    name: "MCP client",
    scope: "openid profile email mcp:read mcp:invoke",
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(`${process.env.APP_URL!}/api/auth`)
    .setAudience([getMcpOrgResourceUri(orgId)])
    .setIssuedAt()
    .setExpirationTime("2m")
    .setSubject(sub)
    .sign(privateKey);
}

describe("an external MCP client and the assistant's memory", () => {
  let ctx: TestContext;
  let headers: Record<string, string>;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    const { setMcpOrgVerifyAudiences } = await import("../../../../../lib/audiences.ts");
    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    const other = await createTestOrg(ctx.user.id);
    setMcpOrgVerifyAudiences([ctx.orgId, other.org.id]);
    const { db } = await import("@appstrate/db/client");
    const { userMemories } = await import("@appstrate/db/schema");
    await db.insert(userMemories).values({
      id: "mem_elsewhere",
      userId: ctx.user.id,
      orgId: other.org.id,
      type: "project",
      content: "Secret project learned elsewhere",
      createdBy: "user",
    });
    const clientId = await ensureInstanceClient("http://localhost:3000");
    const token = await mcpToken(ctx.user.id, clientId, ctx.orgId);
    headers = {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      Accept: MCP_ACCEPT,
    };
  });

  async function call(name: string, args: Record<string, unknown>) {
    const res = await app.request(`/api/mcp/o/${ctx.orgId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
    return body.result?.content?.[0]?.text ?? JSON.stringify(body);
  }

  it("reads through invoke_operation exactly what its memory tool reads: nothing from another organization", async () => {
    await call("memory", { action: "add", type: "preference", content: "Short answers" });
    const out = await call("invoke_operation", {
      operation_id: "listMyMemories",
      space_id: ctx.defaultSpaceId,
    });
    expect(out).toContain("Short answers");
    expect(out).not.toContain("Secret project learned elsewhere");
  });

  it("keeps its memory tool, bounded to the endpoint's organization", async () => {
    await call("memory", { action: "add", type: "preference", content: "Short answers" });
    const view = await call("memory", { action: "view" });
    expect(view).toContain("Short answers");
    expect(view).not.toContain("Secret project learned elsewhere");
  });
});
