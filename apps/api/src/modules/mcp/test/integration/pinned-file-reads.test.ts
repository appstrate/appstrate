// SPDX-License-Identifier: Apache-2.0

/**
 * The space-pinned endpoint (`/api/mcp/o/:org/s/:space`) confines every door of the request,
 * the file readers included: a session or an organization-bound token on it reads files of that
 * space alone, and so does `invoke_operation getFile` dispatched from it. The organization
 * endpoint reads a file in its own space under the caller's set there, through both.
 *
 * A credential bound to a set of spaces (the chat's bearer) reads a file by id in the one space
 * its request entered, through REST and every MCP door alike, plus the uploads its issuing
 * conversation holds in the caller's personal space.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../test/helpers/redis.ts";
import { createTestContext, type TestContext } from "../../../../../test/helpers/auth.ts";
import { seedSpace } from "../../../../../test/helpers/seed.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { loopbackHeaders } from "../../../../../test/helpers/loopback.ts";
import { db } from "@appstrate/db/client";
import { chatSessions, runs, uploads } from "@appstrate/db/schema";
import { uploadStream } from "@appstrate/db/storage";
import { eq } from "drizzle-orm";
import { createUpload } from "../../../../services/uploads.ts";
import { createFileFromStream, createFileFromUpload } from "../../../../services/files.ts";
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

  /** `invoke_operation getFile` on `endpoint` (entering `spaceId` on the org one): its status. */
  async function getFileThrough(
    endpoint: string,
    headers: Record<string, string>,
    uri: string,
    spaceId?: string,
  ): Promise<number> {
    const res = await app.request(endpoint, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "invoke_operation",
          arguments: {
            operation_id: "getFile",
            ...(spaceId ? { space_id: spaceId } : {}),
            path_params: { id: uri.replace("appfile://", "") },
          },
        },
      }),
    });
    const envelope = (await res.json()) as JsonRpcEnvelope;
    const content = (envelope.result?.content as Array<{ text: string }>) ?? [];
    return (JSON.parse(content[0]!.text) as { status: number }).status;
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
      expect(await getFileThrough(endpoint, headers, here)).toBe(200);
      for (const uri of [elsewhere, personal]) {
        const refused = await read(endpoint, headers, uri);
        expect(refused.tool).toContain("not_found");
        expect(refused.tool).not.toMatch(/ailleurs|perso/);
        expect(refused.resource.error?.message).toContain("File not found");
        expect(await getFileThrough(endpoint, headers, uri)).toBe(404);
      }
    }

    // The organization endpoint reads each in its own space, under the caller's set there.
    for (const headers of credentials) {
      const orgWide = await read(`/api/mcp/o/${ctx.orgId}`, headers, elsewhere, pinned);
      expect(orgWide.tool).toContain("ailleurs");
      expect(await getFileThrough(`/api/mcp/o/${ctx.orgId}`, headers, elsewhere, pinned)).toBe(200);
    }
  });

  /** `GET /api/files/{id}` entering `spaceId`: its status. */
  async function getFileRest(
    headers: Record<string, string>,
    uri: string,
    spaceId: string,
  ): Promise<number> {
    const res = await app.request(`/api/files/${uri.replace("appfile://", "")}`, {
      headers: { ...headers, "X-Space-Id": spaceId },
    });
    return res.status;
  }

  /** A chat upload of the owner's, held by conversation `sessionId`, in their personal space. */
  async function conversationUpload(sessionId: string): Promise<string> {
    const scope = {
      orgId: ctx.orgId,
      spaceId: (await ensurePersonalSpaceFor(ctx.orgId, ctx.user.id)).id,
    };
    await db.insert(chatSessions).values({ id: sessionId, orgId: ctx.orgId, userId: ctx.user.id });
    const bytes = new TextEncoder().encode("joint");
    const up = await createUpload({
      ...scope,
      createdBy: ctx.user.id,
      name: "joint.txt",
      size: bytes.byteLength,
      mime: "text/plain",
    });
    const [staged] = await db
      .select({ storageKey: uploads.storageKey })
      .from(uploads)
      .where(eq(uploads.id, up.id));
    const [bucket, ...rest] = staged!.storageKey.split("/");
    await uploadStream(bucket!, rest.join("/"), new Blob([bytes]).stream(), { exclusive: true });
    const file = await createFileFromUpload(scope, { type: "user", id: ctx.user.id }, up.id, {
      chatSessionId: sessionId,
    });
    return `appfile://${file.id}`;
  }

  it("a credential bound to a set reads a file by id in the space its request entered, whatever the door", async () => {
    const ofOther = await fileIn(other, "ailleurs");
    const sessionId = `chs_${crypto.randomUUID()}`;
    const own = await conversationUpload(sessionId);
    const endpoint = `/api/mcp/o/${ctx.orgId}`;
    const bound = loopbackHeaders(ctx, ctx.orgId, {
      orgRole: "owner",
      permissions: ["files:read", "runs:read", "mcp:read", "mcp:invoke"],
      spaceIds: [pinned, other],
      chatSessionId: sessionId,
    });

    // Entered in the other turn space, a file of `other` is a missing one, through every door.
    expect(await getFileThrough(endpoint, bound, ofOther, pinned)).toBe(404);
    expect(await getFileRest(bound, ofOther, pinned)).toBe(404);
    expect((await read(endpoint, bound, ofOther, pinned)).tool).toContain("not_found");
    // Entered in its own space, it is read.
    expect(await getFileThrough(endpoint, bound, ofOther, other)).toBe(200);
    expect(await getFileRest(bound, ofOther, other)).toBe(200);
    // `resources/read` enters the file's space, one of the set.
    const resource = await read(endpoint, bound, ofOther);
    expect(JSON.stringify(resource.resource.result)).toContain("ailleurs");

    // The conversation's own upload, in the personal space outside the set, from either space.
    for (const spaceId of [pinned, other]) {
      expect(await getFileThrough(endpoint, bound, own, spaceId)).toBe(200);
      expect(await getFileRest(bound, own, spaceId)).toBe(200);
      expect((await read(endpoint, bound, own, spaceId)).tool).toContain("joint");
    }
  });

  it("a session and an organization-bound token keep their reach for a file by id", async () => {
    const ofOther = await fileIn(other, "ailleurs");
    const endpoint = `/api/mcp/o/${ctx.orgId}`;
    const session = { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId };
    expect(await getFileRest(session, ofOther, pinned)).toBe(200);
    for (const headers of [session, { Authorization: `Bearer ${await mintOrgToken()}` }]) {
      expect(await getFileThrough(endpoint, headers, ofOther, pinned)).toBe(200);
      expect((await read(endpoint, headers, ofOther, pinned)).tool).toContain("ailleurs");
    }
  });
});
