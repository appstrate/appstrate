// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { asRecord } from "@appstrate/core/safe-json";
import { OPERATION_SPACES_META_KEY, SPACE_CHOICE_META_KEY } from "@appstrate/core/mcp-spaces";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import {
  createTestContext,
  memberContext,
  orgOnlyHeaders,
  type TestContext,
} from "../../../../../test/helpers/auth.ts";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import { inSpace, mcpRpc } from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { seedSpace, seedSpaceGrant } from "../../../../../test/helpers/seed.ts";
import { createWebhook } from "../../../webhooks/service.ts";
import { mintMcpLoopbackToken } from "../../../../../../../packages/module-chat/src/loopback-auth.ts";

const rpc = mcpRpc(getTestApp());
await registerTestPlatformApp();

describe("effective target of an MCP operation", () => {
  let owner: TestContext;
  let teamId: string;
  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext();
    teamId = (await seedSpace({ orgId: owner.orgId, name: "Team" })).id;
  });

  async function invoke(
    operation: string,
    args: Record<string, unknown>,
    credential: string | Record<string, string> = orgOnlyHeaders(owner),
  ) {
    const { envelope } = await rpc(
      typeof credential === "string"
        ? { Authorization: `Bearer ${credential}`, "X-Org-Id": owner.orgId }
        : credential,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "invoke_operation", arguments: { operation_id: operation, ...args } },
      },
    );
    const content = envelope.result?.content as { text: string }[];
    return {
      data: asRecord(JSON.parse(content[0]!.text)),
      ids: asRecord(envelope.result?._meta)[OPERATION_SPACES_META_KEY],
      choices: asRecord(envelope.result?._meta)[SPACE_CHOICE_META_KEY],
    };
  }

  it("takes the scope of a webhook from the authorized row, including when an update has no level in its body", async () => {
    const team = await createWebhook({
      level: "space",
      scope: { orgId: owner.orgId, spaceId: teamId },
      url: "https://example.org/hook",
      events: ["run.success"],
    });
    const org = await createWebhook({
      level: "org",
      scope: { orgId: owner.orgId },
      url: "https://example.org/hook",
      events: ["run.success"],
    });
    const fromTeam = await invoke("getWebhook", { path_params: { id: team.id } });
    expect(fromTeam.data).toMatchObject({
      status: 200,
      space: { id: teamId },
      body: { id: team.id },
    });
    expect(fromTeam.ids).toEqual([teamId]);
    const updated = await invoke("updateWebhook", {
      path_params: { id: team.id },
      body: { enabled: false },
    });
    expect(updated.data).toMatchObject({
      status: 200,
      space: { id: teamId },
      body: { enabled: false },
    });
    const fromOrg = await invoke("getWebhook", { path_params: { id: org.id } });
    expect(fromOrg.data.status).toBe(200);
    expect(fromOrg.data.space).toBeUndefined();
    expect(fromOrg.ids).toEqual([]);
  });

  it("checks the invoke grant in the entry and the webhook grant in the target for every address", async () => {
    const caller = await memberContext(owner, "member", "admin");
    await seedSpaceGrant({
      orgId: owner.orgId,
      userId: caller.user.id,
      spaceId: teamId,
      permissions: ["mcp:read", "webhooks:read", "webhooks:write"],
    });
    const headers = orgOnlyHeaders(caller);
    const entry = { space_id: owner.defaultSpaceId };
    const body = {
      level: "space",
      spaceId: teamId,
      events: ["run.success"],
      url: "https://example.org/notify",
    };
    const created = await invoke("createWebhook", { ...entry, body }, headers);
    expect(created.data).toMatchObject({ status: 201, space: { id: teamId } });
    const id = asRecord(created.data.body).id;
    expect(typeof id).toBe("string");
    const byId = { path_params: { id } };
    const list = { query: { spaceId: teamId } };
    for (const [operation, args] of [
      ["getWebhook", byId],
      ["listWebhooks", list],
    ] as const) {
      const allowed = await invoke(operation, { ...args, ...entry }, headers);
      expect(allowed.data).toMatchObject({ status: 200, space: { id: teamId } });
      expect(allowed.ids).toEqual([owner.defaultSpaceId, teamId]);
    }
    expect((await invoke("getWebhook", byId, headers)).data.status).toBe(403);
    expect((await invoke("listWebhooks", list, headers)).data.code).toBe("not_granted");
    expect((await invoke("createWebhook", { body }, headers)).data.code).toBe("not_granted");
  });

  it("refuses a webhook outside an org-wide or pinned connection by row, filter and body", async () => {
    const caller = await memberContext(owner, "member", "admin");
    await seedSpaceGrant({
      orgId: owner.orgId,
      userId: caller.user.id,
      spaceId: teamId,
      permissions: ["webhooks:read", "webhooks:write"],
    });
    const pinned = inSpace(orgOnlyHeaders(owner), owner.defaultSpaceId);
    const body = {
      level: "space",
      spaceId: teamId,
      events: ["run.success"],
      url: "https://example.org/notify",
    };
    const webhook = await createWebhook({
      level: "space",
      scope: { orgId: owner.orgId, spaceId: teamId },
      url: body.url,
      events: ["run.success"],
    });
    for (const [headers, entry] of [
      [pinned, {}],
      [orgOnlyHeaders(caller), { space_id: owner.defaultSpaceId }],
    ] as const) {
      const detail = await invoke(
        "getWebhook",
        { ...entry, path_params: { id: webhook.id } },
        headers,
      );
      expect(detail.data.status).toBe(404);
      expect(detail.ids).toEqual([]);
      const list = await invoke("listWebhooks", { ...entry, query: { spaceId: teamId } }, headers);
      expect(list.data.code).toBe("unknown_space");
      expect(list.ids).toEqual([]);
      expect((await invoke("createWebhook", { ...entry, body }, headers)).data.code).toBe(
        "unknown_space",
      );
    }
  });

  it("keeps the target's REST permission when the entry grants webhook access", async () => {
    const caller = await memberContext(owner, "member", "admin");
    await seedSpaceGrant({
      orgId: owner.orgId,
      userId: caller.user.id,
      spaceId: teamId,
      permissions: ["mcp:read", "mcp:invoke"],
    });
    const webhook = await createWebhook({
      level: "space",
      scope: { orgId: owner.orgId, spaceId: teamId },
      url: "https://example.org/notify",
      events: ["run.success"],
    });
    const headers = orgOnlyHeaders(caller);
    for (const [operation, args] of [
      ["getWebhook", { path_params: { id: webhook.id } }],
      ["listWebhooks", { query: { spaceId: teamId } }],
      [
        "createWebhook",
        { body: { level: "space", spaceId: teamId, url: webhook.url, events: ["run.success"] } },
      ],
    ] as const) {
      const result = await invoke(operation, { space_id: owner.defaultSpaceId, ...args }, headers);
      expect(result.data.status).toBe(403);
    }
  });

  it("refuses repeated scope selectors on a filtered resource list", async () => {
    for (const query of [{ spaceId: [teamId] }, { all: [true] }]) {
      const result = await invoke("listWebhooks", { query });
      expect(result.data.code).toBe("invalid_argument");
      expect(result.choices).toBeUndefined();
    }
  });

  it("asks for a missing path or discriminated body space and fills only that parameter on selection", async () => {
    for (const [operation, args, status] of [
      ["listSpaceMembers", {}, 200],
      [
        "createWebhook",
        { body: { level: "space", events: ["run.success"], url: "https://example.org/notify" } },
        201,
      ],
    ] as const) {
      const missing = await invoke(operation, args);
      expect(missing.data.code).toBe("missing_argument");
      expect(missing.choices).toContain(teamId);
      const selected = await invoke(operation, { ...args, space_id: teamId });
      expect(selected.data).toMatchObject({ status, space: { id: teamId } });
      expect(selected.ids).toEqual([teamId]);
    }
    const org = await invoke("createWebhook", {
      body: { level: "org", events: ["run.success"], url: "https://example.org/notify" },
    });
    expect(org.data.status).toBe(201);
    expect(org.ids).toEqual([]);
  });

  it("does not ask for a space when the credential lacks the selected branch's grant", async () => {
    const token = mintMcpLoopbackToken({
      userId: owner.user.id,
      name: owner.user.name,
      email: owner.user.email,
      orgId: owner.orgId,
      orgRole: "owner",
      permissions: ["mcp:read", "mcp:invoke", "org-webhooks:write"],
      spaceIds: [owner.defaultSpaceId, teamId],
    });
    for (const [operation, args] of [
      ["listSpaceMembers", {}],
      ["createWebhook", { body: { level: "space" } }],
    ] as const) {
      const unavailable = await invoke(operation, args, token);
      expect(unavailable.data.code).toBe("not_granted");
      expect(unavailable.choices).toBeUndefined();
    }
  });

  it("reads organization and row targets across a chat bearer's allowed spaces", async () => {
    const token = mintMcpLoopbackToken({
      userId: owner.user.id,
      name: owner.user.name,
      email: owner.user.email,
      orgId: owner.orgId,
      orgRole: "owner",
      permissions: ["mcp:read", "mcp:invoke", "spaces:read", "webhooks:read"],
      spaceIds: [owner.defaultSpaceId, teamId],
      originSpaceId: owner.defaultSpaceId,
      restricted: false,
    });
    const detail = await invoke("getSpace", { path_params: { id: teamId } }, token);
    expect(detail.data).toMatchObject({ status: 200, body: { id: teamId } });
    expect(detail.ids).toEqual([]);
    const outside = await seedSpace({ orgId: owner.orgId, name: "Outside turn" });
    expect((await invoke("getSpace", { path_params: { id: outside.id } }, token)).data.status).toBe(
      404,
    );
    const hook = await createWebhook({
      level: "space",
      scope: { orgId: owner.orgId, spaceId: teamId },
      url: "https://example.org/notify",
      events: ["run.success"],
    });
    const row = await invoke("getWebhook", { path_params: { id: hook.id } }, token);
    expect(row.data).toMatchObject({ status: 200, space: { id: teamId } });
    expect(row.ids).toEqual([teamId]);
  });

  it("honors the space chosen on the previous turn, refusing conflicting named and route targets", async () => {
    const tokenFor = (operationId: string) =>
      mintMcpLoopbackToken({
        userId: owner.user.id,
        name: owner.user.name,
        email: owner.user.email,
        orgId: owner.orgId,
        orgRole: "owner",
        permissions: ["mcp:read", "mcp:invoke", "agents:read", "space-members:read"],
        spaceIds: [owner.defaultSpaceId, teamId],
        originSpaceId: owner.defaultSpaceId,
        restricted: false,
        spaceChoice: { tool: "invoke_operation", operationId, spaceId: teamId },
      });
    const resumed = await invoke("listSpaceMembers", {}, tokenFor("listSpaceMembers"));
    expect(resumed.data).toMatchObject({ status: 200, space: { id: teamId } });
    const token = tokenFor("listAgents");
    const selected = await invoke("listAgents", {}, token);
    expect(selected.data).toMatchObject({ status: 200, space: { id: teamId } });
    expect((await invoke("listAgents", { space_id: owner.defaultSpaceId }, token)).data.code).toBe(
      "space_mismatch",
    );
    expect(
      (
        await invoke(
          "listSpaceMembers",
          { path_params: { id: owner.defaultSpaceId } },
          tokenFor("listSpaceMembers"),
        )
      ).data.code,
    ).toBe("space_mismatch");
  });
});
