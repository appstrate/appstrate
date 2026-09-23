// SPDX-License-Identifier: Apache-2.0

/**
 * The chat composer's agent-authoring switch, platform half. The handler mints
 * the turn's MCP loopback bearer from `turnPermissions(...)`; here a real
 * `builder` presents a bearer minted both ways, and the platform's own guards
 * must refuse the authoring surfaces only on the narrowed one. Every refusal
 * has its control on the unnarrowed bearer, so none can pass by the request
 * failing for another reason.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext } from "../../helpers/auth.ts";
import { mcpRpc } from "../../helpers/mcp.ts";
import { registerTestPlatformApp } from "../../helpers/platform-app.ts";
// By path, as `view-as.test.ts` does: the minting secret is process-local to
// that file, and this is the module instance the chat module registered its
// auth strategy from.
import { mintMcpLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";
import { turnPermissions } from "../../../../../packages/module-chat/src/turn-permissions.ts";

const app = getTestApp();
await registerTestPlatformApp();
const rpc = mcpRpc(app);

interface ListedSpace {
  id: string;
  permissions: string[];
}

let bearer: (authoring: boolean) => Record<string, string>;

beforeEach(async () => {
  await truncateAll();
  const owner = await createTestContext({ orgSlug: "chat-authoring-ceiling" });
  const builder = await memberContext(owner, "member", "builder");

  // The set `c.get("permissions")` holds on the builder's own `/api/chat`
  // request — read from the platform, not written down here.
  const listed = await app.request("/api/spaces", {
    headers: { Cookie: builder.cookie, "X-Org-Id": builder.orgId },
  });
  expect(listed.status).toBe(200);
  const { data } = (await listed.json()) as { data: ListedSpace[] };
  const resolved = data.find((space) => space.id === builder.defaultSpaceId)!.permissions;
  // The premise: the role grants both, so a 403 below can only come from the token.
  for (const permission of ["agents:write", "agents:run", "mcp:read"]) {
    expect(resolved).toContain(permission);
  }

  bearer = (authoring) => {
    const token = mintMcpLoopbackToken({
      userId: builder.user.id,
      email: builder.user.email,
      name: builder.user.name,
      orgId: builder.orgId,
      orgRole: "member",
      permissions: turnPermissions(resolved, authoring),
    });
    return {
      Authorization: `Bearer ${token}`,
      "X-Org-Id": builder.orgId,
      "X-Space-Id": builder.defaultSpaceId,
    };
  };
});

/** POST `{}`: past the permission guard it is a 400, so a 403 is the guard. */
function postEmpty(path: string, authoring: boolean) {
  return app.request(path, {
    method: "POST",
    headers: { ...bearer(authoring), "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("a chat turn with agent authoring switched off", () => {
  it("is refused by POST /api/runs/inline although the builder's role grants it", async () => {
    const off = await postEmpty("/api/runs/inline", false);
    expect(off.status, await off.clone().text()).toBe(403);
    const on = await postEmpty("/api/runs/inline", true);
    expect(on.status, await on.clone().text()).toBe(400);
  });

  it("is refused by the agent creation route although the builder's role grants it", async () => {
    const off = await postEmpty("/api/packages/agents", false);
    expect(off.status, await off.clone().text()).toBe(403);
    const on = await postEmpty("/api/packages/agents", true);
    expect(on.status, await on.clone().text()).toBe(400);
  });

  it("gets a `run_and_wait` that offers existing agents only", async () => {
    const runAndWait = async (authoring: boolean) => {
      const { status, envelope } = await rpc(bearer(authoring), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      expect(status).toBe(200);
      const tools = envelope.result!.tools as Array<{
        name: string;
        inputSchema: { properties: Record<string, { enum?: string[] }> };
      }>;
      return tools.find((tool) => tool.name === "run_and_wait")!.inputSchema.properties;
    };

    const off = await runAndWait(false);
    expect(off.kind!.enum).toEqual(["agent"]);
    expect(Object.keys(off)).not.toContain("context_files");
    expect(Object.keys(off)).not.toContain("manifest");

    const on = await runAndWait(true);
    expect(on.kind!.enum).toEqual(["agent", "inline"]);
    expect(Object.keys(on)).toContain("context_files");
    expect(Object.keys(on)).toContain("manifest");
  });
});
