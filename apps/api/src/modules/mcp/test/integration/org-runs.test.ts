// SPDX-License-Identifier: Apache-2.0

/**
 * `listOrgRuns` through `invoke_operation`, with real minted MCP instance tokens.
 * The rule lives in the service (`test/integration/routes/org-runs.test.ts`
 * holds its truth table), so this door must answer what the REST door answers:
 *
 *   - an organization-bound token, whichever space the call names to enter,
 *     reads every space of the caller's reach, each by its own role;
 *   - a space-bound token reads that space only.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../test/helpers/redis.ts";
import {
  createTestContext,
  memberContext,
  type TestContext,
} from "../../../../../test/helpers/auth.ts";
import {
  seedPackage,
  seedRun,
  seedSpace,
  seedSpaceMember,
  seedSpaceRole,
} from "../../../../../test/helpers/seed.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { getMcpOrgResourceUri, getMcpSpaceResourceUri } from "../../../../lib/audiences.ts";
import { overrideJwks } from "../../../oidc/services/enduser-token.ts";
import { resetOidcGuardsLimiters } from "../../../oidc/auth/guards.ts";
import { authorizationCodeFlow } from "../../../oidc/test/helpers/authorization-code-flow.ts";
import mcpModule from "../../index.ts";

const app = getTestApp();
await registerTestPlatformApp();

const REDIRECT_URI = "http://localhost:9918/callback";

describe("listOrgRuns through invoke_operation", () => {
  let owner: TestContext;
  let member: TestContext;
  let un: string;
  let deux: string;
  let r: Record<string, string>;

  async function seedSpaceRun(spaceId: string, userId: string) {
    const pkg = await seedPackage({
      id: `@mcporgruns/agent-${crypto.randomUUID().slice(0, 8)}`,
      orgId: owner.orgId,
      homeSpaceId: spaceId,
      createdBy: userId,
    });
    const run = await seedRun({
      packageId: pkg.id,
      orgId: owner.orgId,
      spaceId,
      userId,
      status: "success",
      startedAt: new Date(),
    });
    return run.id;
  }

  async function mintToken(ctx: TestContext, resource: string): Promise<string> {
    const registered = await app.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "MCP client (org runs)",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect([200, 201]).toContain(registered.status);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const { token } = await authorizationCodeFlow(app, {
      cookie: ctx.cookie,
      clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid mcp:read mcp:invoke",
      resource,
    });
    return String(token.access_token);
  }

  /** `listOrgRuns` invoked on `endpoint`; `spaceId` is the call's `space_id` (org-wide mode only). */
  async function invokeListOrgRuns(
    endpoint: string,
    token: string,
    spaceId?: string,
  ): Promise<string[]> {
    const res = await app.request(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "invoke_operation",
          arguments: {
            operation_id: "listOrgRuns",
            path_params: { orgId: owner.orgId },
            ...(spaceId ? { space_id: spaceId } : {}),
          },
        },
      }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const envelope = JSON.parse(text) as JsonRpcEnvelope;
    const content = envelope.result?.content as Array<{ text: string }>;
    expect(envelope.result?.isError, content[0]!.text).toBeFalsy();
    const { status, body } = JSON.parse(content[0]!.text) as {
      status: number;
      body: { data: Array<{ id: string }> };
    };
    expect(status).toBe(200);
    return body.data.map((run) => run.id).sort();
  }

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwks(null);
    owner = await createTestContext({ orgSlug: "mcporgruns" });
    await mcpModule.events!.onOrgCreate!(owner.orgId, owner.user.email);
    member = await memberContext(owner, "member");
    un = (await seedSpace({ orgId: owner.orgId, name: "Un", visibility: "closed" })).id;
    deux = (await seedSpace({ orgId: owner.orgId, name: "Deux", visibility: "closed" })).id;
    // MCP access in both spaces; every run in Un, own runs only in Deux.
    const readAll = await seedSpaceRole({
      orgId: owner.orgId,
      permissions: ["mcp:read", "mcp:invoke", "runs:read-all"],
    });
    const readOwn = await seedSpaceRole({
      orgId: owner.orgId,
      permissions: ["mcp:read", "mcp:invoke", "runs:read"],
    });
    for (const [spaceId, role] of [
      [un, readAll],
      [deux, readOwn],
    ] as const) {
      await seedSpaceMember({
        spaceId,
        userId: member.user.id,
        presetRole: null,
        customRoleId: role.id,
      });
    }
    r = {
      unOwner: await seedSpaceRun(un, owner.user.id),
      unMember: await seedSpaceRun(un, member.user.id),
      deuxOwner: await seedSpaceRun(deux, owner.user.id),
      deuxMember: await seedSpaceRun(deux, member.user.id),
    };
  });

  it("answers an organization-bound token what the REST door answers, whichever space it entered", async () => {
    const rest = await app.request(`/api/orgs/${owner.orgId}/runs`, {
      headers: { Cookie: member.cookie },
    });
    expect(rest.status).toBe(200);
    const restIds = ((await rest.json()) as { data: Array<{ id: string }> }).data
      .map((run) => run.id)
      .sort();
    expect(restIds).toEqual([r.unOwner!, r.unMember!, r.deuxMember!].sort());

    const token = await mintToken(member, getMcpOrgResourceUri(owner.orgId));
    const endpoint = `/api/mcp/o/${owner.orgId}`;
    // The entered space decides nothing here: each row's space decides it. The
    // default space (implicit `operator`) is reached too and holds no run.
    expect(await invokeListOrgRuns(endpoint, token, un)).toEqual(restIds);
    expect(await invokeListOrgRuns(endpoint, token, deux)).toEqual(restIds);
  });

  it("bounds a space-bound token to its space", async () => {
    const token = await mintToken(member, getMcpSpaceResourceUri(owner.orgId, deux));
    const ids = await invokeListOrgRuns(`/api/mcp/o/${owner.orgId}/s/${deux}`, token);
    expect(ids).toEqual([r.deuxMember!]);
  });
});
