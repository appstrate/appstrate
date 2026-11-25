// SPDX-License-Identifier: Apache-2.0

/**
 * The lists spanning spaces through `invoke_operation`, with real minted MCP
 * instance tokens. The rules live in the services (the truth tables are in
 * `test/integration/routes/cross-space-reads.test.ts` and
 * `org-{runs,schedules,files,packages}.test.ts`), so this door answers what
 * the REST door answers; one list (`listOrgRuns`) per binding mode:
 *
 *   - an organization-bound token, whichever space the call names to enter,
 *     reads every space of the caller's reach, each by its own role;
 *   - a space-bound token reads that space only, and the package reach behind
 *     `home_*` is that space only too;
 *   - an organization-bound token on a space's endpoint reads that space only.
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
  seedSpaceGrant,
  seedSpacePackage,
} from "../../../../../test/helpers/seed.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { getMcpOrgResourceUri, getMcpSpaceResourceUri } from "../../../../lib/audiences.ts";
import { overrideJwks } from "../../../oidc/services/enduser-token.ts";
import { resetOidcGuardsLimiters } from "../../../oidc/auth/guards.ts";
import { authorizationCodeFlow } from "../../../oidc/test/helpers/authorization-code-flow.ts";
import mcpModule from "../../index.ts";
import { mintMcpLoopbackToken } from "../../../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();
await registerTestPlatformApp();

const REDIRECT_URI = "http://localhost:9918/callback";

/** The rows this file seeds: run ids, and its own packages' ids. */
const seeded = (id: string) => !id.startsWith("@") || id.startsWith("@mcporgreads/");
type Operation = "listOrgRuns" | "listOrgSkills";
interface HomeWire {
  home_space_id: string | null;
  home_writable: boolean;
  home_deletable: boolean;
  home_shareable: boolean;
}

describe("lists spanning spaces through invoke_operation", () => {
  let owner: TestContext;
  let member: TestContext;
  let un: string;
  let deux: string;
  /** The run ids the member reads, by space. */
  let runIds: { un: string[]; deux: string[] };

  /** One agent of the owner's in `spaceId`, with a run of the owner's and one of the member's. */
  async function seedSpaceRuns(spaceId: string) {
    const pkg = await seedPackage({
      id: `@mcporgreads/agent-${crypto.randomUUID().slice(0, 8)}`,
      orgId: owner.orgId,
      homeSpaceId: spaceId,
      createdBy: owner.user.id,
    });
    const runs: Record<string, string> = {};
    for (const [who, userId] of [
      ["owner", owner.user.id],
      ["member", member.user.id],
    ] as const) {
      const run = await seedRun({
        packageId: pkg.id,
        orgId: owner.orgId,
        spaceId,
        userId,
        status: who === "owner" ? "failed" : "success",
        startedAt: new Date(),
      });
      runs[who] = run.id;
    }
    return runs;
  }

  async function seedSkill(name: string, homeSpaceId: string): Promise<string> {
    const pkg = await seedPackage({
      id: `@mcporgreads/${name}`,
      orgId: owner.orgId,
      type: "skill",
      homeSpaceId,
      createdBy: owner.user.id,
      draftManifest: { name: `@mcporgreads/${name}`, version: "0.1.0", type: "skill" },
    });
    return pkg.id;
  }

  async function mintToken(ctx: TestContext, resource: string): Promise<string> {
    const registered = await app.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "MCP client (org reads)",
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

  /** `operation` invoked on `endpoint`; `spaceId` is the call's `space_id` (org-wide mode only). */
  async function invoke(
    operation: Operation,
    endpoint: string,
    token: string,
    spaceId?: string,
  ): Promise<string[]> {
    return (await invokeRows(operation, endpoint, token, spaceId))
      .map((row) => row.id)
      .filter(seeded)
      .sort();
  }

  /** The rows `invoke` reads the ids of. */
  async function invokeRows(
    operation: Operation,
    endpoint: string,
    token: string,
    spaceId?: string,
    query?: Record<string, unknown>,
  ): Promise<Array<{ id: string; space_ids?: string[] } & Partial<HomeWire>>> {
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
            operation_id: operation,
            query,
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
      body: { data: Array<{ id: string; spaceId: string; home_space_id?: string | null }> };
    };
    expect(status).toBe(200);
    return body.data;
  }

  async function restRuns(query = ""): Promise<string[]> {
    const res = await app.request(`/api/orgs/${owner.orgId}/runs${query}`, {
      headers: { Cookie: member.cookie },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Array<{ id: string }> }).data.map((row) => row.id).sort();
  }

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwks(null);
    owner = await createTestContext({ orgSlug: "mcporgreads" });
    await mcpModule.events!.onOrgCreate!(owner.orgId, owner.user.email);
    member = await memberContext(owner, "member");
    un = (await seedSpace({ orgId: owner.orgId, name: "Un", visibility: "closed" })).id;
    deux = (await seedSpace({ orgId: owner.orgId, name: "Deux", visibility: "closed" })).id;
    // MCP access in both spaces. Un: every run. Deux: own runs only. Both
    // author their skills (read, write, delete, share).
    const skills = ["skills:read", "skills:write", "skills:delete", "skills:share"];
    const grant = (spaceId: string, permissions: string[]) =>
      seedSpaceGrant({ orgId: owner.orgId, spaceId, userId: member.user.id, permissions });
    await grant(un, ["mcp:read", "mcp:invoke", "runs:read-all", ...skills]);
    await grant(deux, ["mcp:read", "mcp:invoke", "runs:read", ...skills]);
    const inUn = await seedSpaceRuns(un);
    const inDeux = await seedSpaceRuns(deux);
    runIds = { un: [inUn.owner!, inUn.member!], deux: [inDeux.member!] };
  });

  it("answers an organization-bound token what the REST door answers, whichever space it entered", async () => {
    const restIds = await restRuns();
    expect(restIds).toEqual([...runIds.un, ...runIds.deux].sort());

    const token = await mintToken(member, getMcpOrgResourceUri(owner.orgId));
    const endpoint = `/api/mcp/o/${owner.orgId}`;
    // The entered space decides nothing here: each row's space decides it.
    // The default space (implicit `operator`) is reached too and holds no row.
    expect(await invoke("listOrgRuns", endpoint, token)).toEqual(restIds);
    expect(await invoke("listOrgRuns", endpoint, token, un)).toEqual(restIds);
    expect(await invoke("listOrgRuns", endpoint, token, deux)).toEqual(restIds);
  });

  it("reads the conversation's origin when its signed bearer can reach two spaces", async () => {
    const token = mintMcpLoopbackToken({
      userId: member.user.id,
      name: member.user.name,
      email: member.user.email,
      orgId: owner.orgId,
      orgRole: "member",
      permissions: ["mcp:read", "mcp:invoke", "runs:read", "runs:read-all"],
      spaceIds: [un, deux],
      originSpaceId: deux,
      restricted: false,
    });
    const endpoint = `/api/mcp/o/${owner.orgId}`;
    expect(await invoke("listOrgRuns", endpoint, token)).toEqual(runIds.deux);
    expect(await invoke("listOrgRuns", endpoint, token, un)).toEqual([...runIds.un].sort());
  });

  it("returns the same failed and successful runs through CSV REST and MCP arrays", async () => {
    const token = await mintToken(member, getMcpOrgResourceUri(owner.orgId));
    const statuses = ["failed", "success"];
    const rest = await restRuns("?status=failed,success");
    const mcp = await invokeRows("listOrgRuns", `/api/mcp/o/${owner.orgId}`, token, un, {
      status: statuses,
    });
    expect(rest).toEqual([...runIds.un, ...runIds.deux].sort());
    expect(mcp.map((row) => row.id).sort()).toEqual(rest);
  });

  it("bounds a space-bound token to its space", async () => {
    const token = await mintToken(member, getMcpSpaceResourceUri(owner.orgId, deux));
    expect(await invoke("listOrgRuns", `/api/mcp/o/${owner.orgId}/s/${deux}`, token)).toEqual(
      runIds.deux,
    );
  });

  it("bounds an organization-bound token on a space's endpoint to that space", async () => {
    const token = await mintToken(member, getMcpOrgResourceUri(owner.orgId));
    expect(await invoke("listOrgRuns", `/api/mcp/o/${owner.orgId}/s/${deux}`, token)).toEqual(
      runIds.deux,
    );
  });

  it("follows the REST rule in a space whose role grants no mcp:read, which the connection cannot act in", async () => {
    // `mcp:read` decides the spaces a connection may enter and act in; a list
    // spanning spaces is the REST read, row by row, whichever door serves it.
    const trois = (await seedSpace({ orgId: owner.orgId, name: "Trois", visibility: "closed" })).id;
    await seedSpaceGrant({
      orgId: owner.orgId,
      spaceId: trois,
      userId: member.user.id,
      permissions: ["runs:read-all"],
    });
    const inTrois = await seedSpaceRuns(trois);
    const token = await mintToken(member, getMcpOrgResourceUri(owner.orgId));
    const endpoint = `/api/mcp/o/${owner.orgId}`;
    const viaMcp = await invoke("listOrgRuns", endpoint, token, un);
    expect(viaMcp).toEqual(await restRuns());
    expect(viaMcp).toEqual(expect.arrayContaining([inTrois.owner!, inTrois.member!]));

    // Entering Trois itself is refused: the connection acts there in nothing.
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
            space_id: trois,
          },
        },
      }),
    });
    const envelope = JSON.parse(await res.text()) as JsonRpcEnvelope;
    expect(JSON.stringify(envelope)).toContain("unknown_space");
  });

  it("computes home_* over the token's pinned space only", async () => {
    // Homed in Un, where the member holds a role, and active in Deux too.
    const shared = await seedSkill("shared", un);
    await seedSpacePackage(deux, shared);
    const sharedOf = (rows: Awaited<ReturnType<typeof invokeRows>>) =>
      rows.find((row) => row.id === shared)!;

    const orgToken = await mintToken(member, getMcpOrgResourceUri(owner.orgId));
    const orgRows = await invokeRows("listOrgSkills", `/api/mcp/o/${owner.orgId}`, orgToken, deux);
    expect(sharedOf(orgRows).home_space_id).toBe(un);

    // Bound to Deux, the token reaches no role in Un: the home is not named.
    const spaceToken = await mintToken(member, getMcpSpaceResourceUri(owner.orgId, deux));
    const pinnedRows = await invokeRows(
      "listOrgSkills",
      `/api/mcp/o/${owner.orgId}/s/${deux}`,
      spaceToken,
    );
    expect(pinnedRows.every((row) => row.space_ids?.join() === deux)).toBe(true);
    expect(sharedOf(pinnedRows).home_space_id).toBeNull();
  });

  it("bounds the home authority of an organization-bound token on a space's endpoint to that space", async () => {
    // Both active in Deux; one homed there, the other homed in Un.
    const inside = await seedSkill("inside", deux);
    const outside = await seedSkill("outside", un);
    await seedSpacePackage(deux, inside);
    await seedSpacePackage(deux, outside);
    const homeOf = (rows: Awaited<ReturnType<typeof invokeRows>>, id: string): HomeWire => {
      const { home_space_id, home_writable, home_deletable, home_shareable } = rows.find(
        (row) => row.id === id,
      )!;
      return { home_space_id, home_writable, home_deletable, home_shareable } as HomeWire;
    };
    const authority = (home: string | null, held: boolean): HomeWire => ({
      home_space_id: home,
      home_writable: held,
      home_deletable: held,
      home_shareable: held,
    });

    const token = await mintToken(member, getMcpOrgResourceUri(owner.orgId));
    // On the organization's endpoint the member authors both, from their homes.
    const orgRows = await invokeRows("listOrgSkills", `/api/mcp/o/${owner.orgId}`, token, deux);
    expect(homeOf(orgRows, inside)).toEqual(authority(deux, true));
    expect(homeOf(orgRows, outside)).toEqual(authority(un, true));

    // The same token on Deux's endpoint holds no authority from Un.
    const pinnedRows = await invokeRows(
      "listOrgSkills",
      `/api/mcp/o/${owner.orgId}/s/${deux}`,
      token,
    );
    expect(homeOf(pinnedRows, inside)).toEqual(authority(deux, true));
    expect(homeOf(pinnedRows, outside)).toEqual(authority(null, false));
  });
});
