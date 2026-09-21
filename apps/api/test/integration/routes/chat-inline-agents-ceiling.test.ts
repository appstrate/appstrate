// SPDX-License-Identifier: Apache-2.0

/**
 * The chat composer's inline-agents switch, platform half.
 *
 * With the switch off, `chat-stream.ts` mints the turn's MCP loopback bearer
 * from the caller's resolved permissions MINUS `agents:run-inline` — pinned in
 * `packages/module-chat/test/chat-stream-handler.test.ts`. What that test cannot
 * see is whether the platform honours the narrowed bearer for a caller whose
 * ROLE grants the permission. Here a real `operator` (whose preset carries
 * `agents:run-inline`) presents both bearers: the narrowing below is the same
 * one-line filter the handler applies, and every assertion has its control on
 * the unnarrowed token, so neither half can pass by the request simply failing.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { addOrgMember, createTestContext, createTestUser } from "../../helpers/auth.ts";
import { seedSpaceMember } from "../../helpers/seed.ts";
import { setPlatformApp } from "../../../src/lib/platform-app.ts";
import { resetCatalog } from "../../../src/modules/mcp/catalog.ts";
// By path, as `view-as.test.ts` does: the minting secret is process-local to
// that file, and this is the module instance the discovered chat module
// registered its auth strategy from.
import { mintMcpLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();
setPlatformApp(app);

const INLINE = "agents:run-inline";

interface ListedSpace {
  id: string;
  permissions: string[];
}

let bearer: (inlineAgents: boolean) => Record<string, string>;

beforeEach(async () => {
  await truncateAll();
  resetCatalog();
  const owner = await createTestContext({ orgSlug: "chat-inline-ceiling" });
  const operator = await createTestUser();
  await addOrgMember(owner.orgId, operator.id, "member");
  await seedSpaceMember({
    spaceId: owner.defaultSpaceId,
    userId: operator.id,
    presetRole: "operator",
  });

  // The set `c.get("permissions")` holds on the operator's own `/api/chat`
  // request — read from the platform, not written down here.
  const listed = await app.request("/api/spaces", {
    headers: { Cookie: operator.cookie, "X-Org-Id": owner.orgId },
  });
  expect(listed.status).toBe(200);
  const { data } = (await listed.json()) as { data: ListedSpace[] };
  const resolved = data.find((space) => space.id === owner.defaultSpaceId)!.permissions;
  // The premise: the role grants it, so a 403 below can only come from the token.
  expect(resolved).toContain(INLINE);
  expect(resolved).toContain("mcp:read");

  bearer = (inlineAgents) => {
    const token = mintMcpLoopbackToken({
      userId: operator.id,
      email: operator.email,
      name: operator.name,
      orgId: owner.orgId,
      orgRole: "member",
      permissions: resolved.filter((permission) => inlineAgents || permission !== INLINE),
    });
    return {
      Authorization: `Bearer ${token}`,
      "X-Org-Id": owner.orgId,
      "X-Space-Id": owner.defaultSpaceId,
    };
  };
});

describe("a chat turn with inline agents switched off", () => {
  it("is refused by POST /api/runs/inline although the operator's role grants it", async () => {
    // `{}` is not a valid inline body: past the permission guard it is a 400.
    // A 403 therefore means the guard refused the bearer, not the payload.
    const launch = (inlineAgents: boolean) =>
      app.request("/api/runs/inline", {
        method: "POST",
        headers: { ...bearer(inlineAgents), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

    const off = await launch(false);
    expect(off.status, await off.clone().text()).toBe(403);
    const on = await launch(true);
    expect(on.status, await on.clone().text()).toBe(400);
  });

  it("gets a `run_and_wait` that offers existing agents only", async () => {
    const runAndWait = async (inlineAgents: boolean) => {
      const headers = bearer(inlineAgents);
      const res = await app.request(`/api/mcp/o/${headers["X-Org-Id"]}`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as {
        result: { tools: Array<{ name: string; inputSchema: { properties: object } }> };
      };
      const tool = envelope.result.tools.find((candidate) => candidate.name === "run_and_wait")!;
      return tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    };

    const off = await runAndWait(false);
    expect(off.kind!.enum).toEqual(["agent"]);
    expect(Object.keys(off)).not.toContain("context_files");
    expect(Object.keys(off)).not.toContain("manifest");

    const on = await runAndWait(true);
    expect(on.kind!.enum).toEqual(["agent", "inline"]);
    expect(Object.keys(on)).toContain("context_files");
  });
});
