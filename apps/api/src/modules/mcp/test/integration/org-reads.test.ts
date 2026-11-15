// SPDX-License-Identifier: Apache-2.0

/**
 * The lists spanning spaces — `listOrgRuns`, `listOrgSchedules`, `listOrgFiles`
 * — through `invoke_operation`, with real minted MCP instance tokens. The rules
 * live in the services (the truth tables are in `test/integration/routes/
 * org-{runs,schedules,files}.test.ts`), so this door must answer what the REST
 * door answers:
 *
 *   - an organization-bound token, whichever space the call names to enter,
 *     reads every space of the caller's reach, each by its own role;
 *   - a space-bound token reads that space only.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { files } from "@appstrate/db/schema";
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
  seedSchedule,
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

const OPERATIONS = {
  listOrgRuns: "runs",
  listOrgSchedules: "schedules",
  listOrgFiles: "files",
} as const;
type Operation = keyof typeof OPERATIONS;

describe("lists spanning spaces through invoke_operation", () => {
  let owner: TestContext;
  let member: TestContext;
  let un: string;
  let deux: string;
  /** The ids the member reads, by resource and space. */
  let ids: Record<(typeof OPERATIONS)[Operation], { un: string[]; deux: string[] }>;

  /**
   * One agent of the owner's per space with a schedule, a run of the owner's
   * and a run of the member's (both fired by the schedule), each run with one
   * output file.
   */
  async function seedSpaceRows(spaceId: string) {
    const pkg = await seedPackage({
      id: `@mcporgreads/agent-${crypto.randomUUID().slice(0, 8)}`,
      orgId: owner.orgId,
      homeSpaceId: spaceId,
      createdBy: owner.user.id,
    });
    const schedule = await seedSchedule({
      packageId: pkg.id,
      orgId: owner.orgId,
      spaceId,
      userId: owner.user.id,
    });
    const rows = {
      schedule: schedule.id,
      runs: {} as Record<string, string>,
      files: {} as Record<string, string>,
    };
    for (const [who, userId] of [
      ["owner", owner.user.id],
      ["member", member.user.id],
    ] as const) {
      const run = await seedRun({
        packageId: pkg.id,
        scheduleId: schedule.id,
        orgId: owner.orgId,
        spaceId,
        userId,
        status: "success",
        startedAt: new Date(),
      });
      const fileId = `file_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      await db.insert(files).values({
        id: fileId,
        orgId: owner.orgId,
        spaceId,
        purpose: "agent_output",
        runId: run.id,
        userId,
        storageKey: `files/${spaceId}/${fileId}/out.txt`,
        name: "out.txt",
        mime: "text/plain",
        size: 1,
        sha256: "0".repeat(64),
      });
      rows.runs[who] = run.id;
      rows.files[who] = fileId;
    }
    return rows;
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
    return body.data.map((row) => row.id).sort();
  }

  async function rest(operation: Operation): Promise<string[]> {
    const res = await app.request(`/api/orgs/${owner.orgId}/${OPERATIONS[operation]}`, {
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
    // MCP access in both spaces. Un: every run and file, and its schedules.
    // Deux: own runs and files only, and no `schedules:read`.
    const readAll = await seedSpaceRole({
      orgId: owner.orgId,
      permissions: ["mcp:read", "mcp:invoke", "runs:read-all", "files:read", "schedules:read"],
    });
    const readOwn = await seedSpaceRole({
      orgId: owner.orgId,
      permissions: ["mcp:read", "mcp:invoke", "runs:read", "files:read"],
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
    const inUn = await seedSpaceRows(un);
    const inDeux = await seedSpaceRows(deux);
    ids = {
      runs: { un: [inUn.runs.owner!, inUn.runs.member!], deux: [inDeux.runs.member!] },
      files: { un: [inUn.files.owner!, inUn.files.member!], deux: [inDeux.files.member!] },
      schedules: { un: [inUn.schedule], deux: [] },
    };
  });

  for (const operation of Object.keys(OPERATIONS) as Operation[]) {
    const resource = OPERATIONS[operation];

    it(`${operation}: answers an organization-bound token what the REST door answers, whichever space it entered`, async () => {
      const restIds = await rest(operation);
      expect(restIds).toEqual([...ids[resource].un, ...ids[resource].deux].sort());

      const token = await mintToken(member, getMcpOrgResourceUri(owner.orgId));
      const endpoint = `/api/mcp/o/${owner.orgId}`;
      // The entered space decides nothing here: each row's space decides it.
      // The default space (implicit `operator`) is reached too and holds no row.
      expect(await invoke(operation, endpoint, token, un)).toEqual(restIds);
      expect(await invoke(operation, endpoint, token, deux)).toEqual(restIds);
    });

    it(`${operation}: bounds a space-bound token to its space`, async () => {
      const token = await mintToken(member, getMcpSpaceResourceUri(owner.orgId, deux));
      expect(await invoke(operation, `/api/mcp/o/${owner.orgId}/s/${deux}`, token)).toEqual(
        [...ids[resource].deux].sort(),
      );
    });
  }

  it("follows the REST rule in a space whose role grants no mcp:read, which the connection cannot act in", async () => {
    // `mcp:read` decides the spaces a connection may enter and act in; a list
    // spanning spaces is the REST read, row by row, whichever door serves it.
    const trois = (await seedSpace({ orgId: owner.orgId, name: "Trois", visibility: "closed" })).id;
    const noMcp = await seedSpaceRole({
      orgId: owner.orgId,
      permissions: ["runs:read-all", "files:read", "schedules:read"],
    });
    await seedSpaceMember({
      spaceId: trois,
      userId: member.user.id,
      presetRole: null,
      customRoleId: noMcp.id,
    });
    const inTrois = await seedSpaceRows(trois);
    const token = await mintToken(member, getMcpOrgResourceUri(owner.orgId));
    const endpoint = `/api/mcp/o/${owner.orgId}`;
    const inTroisIds = {
      runs: [inTrois.runs.owner!, inTrois.runs.member!],
      files: [inTrois.files.owner!, inTrois.files.member!],
      schedules: [inTrois.schedule],
    };
    for (const operation of Object.keys(OPERATIONS) as Operation[]) {
      const viaMcp = await invoke(operation, endpoint, token, un);
      expect(viaMcp).toEqual(await rest(operation));
      expect(viaMcp).toEqual(expect.arrayContaining(inTroisIds[OPERATIONS[operation]]));
    }

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
});
