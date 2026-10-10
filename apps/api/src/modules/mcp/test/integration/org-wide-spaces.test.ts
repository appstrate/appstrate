// SPDX-License-Identifier: Apache-2.0

/**
 * An unpinned connection reaches every space where the caller holds a role
 * (`docs/plans/mcp-org-wide-spaces.md`). The caller here is `operator` in the
 * default space, `admin` in "Gestion" and `viewer` in "Lecture": three roles,
 * so an operation allowed in one space is refused in another.
 */

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { spaceMembers } from "@appstrate/db/schema";
import * as spacesService from "../../../../services/spaces.ts";
import { db } from "../../../../../test/helpers/db.ts";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import { createTestContext, memberContext } from "../../../../../test/helpers/auth.ts";
import { seedApiKey, seedSpace, seedSpaceMember } from "../../../../../test/helpers/seed.ts";
import { MCP_ACCEPT, mcpRpc, type JsonRpcEnvelope } from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";

const app = getTestApp();
await registerTestPlatformApp();
const rpc = mcpRpc(app);
const APP_BASE = getEnv().APP_URL.replace(/\/+$/, "");

function payload(envelope: JsonRpcEnvelope): { isError: boolean; data: Record<string, unknown> } {
  const content = (envelope.result?.content as Array<{ text: string }>) ?? [];
  return {
    isError: Boolean(envelope.result?.isError),
    data: content[0] ? (JSON.parse(content[0].text) as Record<string, unknown>) : {},
  };
}

describe("mcp org-wide connection", () => {
  let headers: Record<string, string>;
  let defaultSpaceId: string;
  let gestion: { id: string };
  let lecture: { id: string };
  let foreign: { id: string };
  let callerId: string;

  beforeEach(async () => {
    await truncateAll();
    const owner = await createTestContext();
    const caller = await memberContext(owner, "member", "operator");
    callerId = caller.user.id;
    defaultSpaceId = owner.defaultSpaceId;
    gestion = await seedSpace({ orgId: owner.orgId, name: "Gestion", visibility: "closed" });
    lecture = await seedSpace({ orgId: owner.orgId, name: "Lecture", visibility: "closed" });
    foreign = await seedSpace({ orgId: owner.orgId, name: "Foreign", visibility: "closed" });
    await seedSpaceMember({ spaceId: gestion.id, userId: caller.user.id, presetRole: "admin" });
    await seedSpaceMember({ spaceId: lecture.id, userId: caller.user.id, presetRole: "viewer" });
    headers = { Cookie: caller.cookie, "X-Org-Id": owner.orgId };
  });

  let nextId = 1;
  const call = async (name: string, args: Record<string, unknown>, h = headers) => {
    const { envelope } = await rpc(h, {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return envelope;
  };

  it("lists the reachable spaces in get_me, the rules in the instructions", async () => {
    const me = payload(await call("get_me", { space_id: gestion.id }));
    const spaces = me.data.spaces as Array<{ id: string; role: string }>;
    const byId = new Map(spaces.map((s) => [s.id, s]));
    expect(byId.get(defaultSpaceId)?.role).toBe("operator");
    expect(byId.get(gestion.id)?.role).toBe("admin");
    expect(byId.get(lecture.id)?.role).toBe("viewer");
    expect(byId.has(foreign.id)).toBe(false);

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    const instructions = envelope.result?.instructions as string;
    expect(instructions).toContain(NO_FALLBACK_FRAGMENT);
    // Roles differ: an operation granted in some spaces only names them, under its own tag.
    expect(instructions).toContain(`createAgent [${gestion.id}]`);
    expect(instructions).toContain(`Gestion (\`${gestion.id}\``);
  });

  it("declares space_id on the tools that act in a space, and only those", async () => {
    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const tools = envelope.result?.tools as Array<{
      name: string;
      inputSchema: { properties?: Record<string, unknown>; required?: string[] };
    }>;
    const spaceArg = (name: string) => {
      const schema = tools.find((t) => t.name === name)?.inputSchema;
      return Boolean(schema?.properties?.space_id) && schema!.required!.includes("space_id");
    };
    expect(spaceArg("invoke_operation")).toBe(true);
    expect(spaceArg("describe_operation")).toBe(true);
    expect(spaceArg("get_me")).toBe(true);
    expect(spaceArg("get_runtime_capabilities")).toBe(false);

    // The schema carries the spaces: clients truncate server instructions.
    const spaceId = tools.find((t) => t.name === "invoke_operation")!.inputSchema.properties!
      .space_id as { enum: string[]; description: string };
    expect(spaceId.enum.sort()).toEqual([defaultSpaceId, gestion.id, lecture.id].sort());
    expect(spaceId.description).toContain("Gestion (`" + gestion.id + "`, role admin)");

    // A tool some spaces grant names them; one every space grants names none.
    const described = (name: string) =>
      (tools.find((t) => t.name === name) as { description?: string } | undefined)?.description;
    const invoke = described("invoke_operation")!;
    // Leading, so a client capping long descriptions keeps it.
    expect(invoke.startsWith("Available in:")).toBe(true);
    expect(invoke).toContain(gestion.id);
    expect(invoke).not.toContain(lecture.id);
    expect(described("read_skill")).not.toContain("Available in:");
  });

  it("requires space_id on a read as on a write, and names the space read", async () => {
    const missing = payload(await call("invoke_operation", { operation_id: "listAgents" }));
    expect(missing.isError).toBe(true);
    expect(missing.data.code).toBe("missing_argument");
    expect(missing.data.error as string).toContain("space_id is required");
    expect(missing.data.accepted as string[]).toContain(defaultSpaceId);

    const inGestion = payload(
      await call("invoke_operation", { operation_id: "listAgents", space_id: gestion.id }),
    );
    expect((inGestion.data.space as { id: string }).id).toBe(gestion.id);
  });

  it("refuses a space the caller does not reach, listing the ones it does", async () => {
    const res = payload(
      await call("invoke_operation", {
        operation_id: "listAgents",
        space_id: foreign.id,
      }),
    );
    expect(res.isError).toBe(true);
    expect(res.data.code).toBe("unknown_space");
    expect(res.data.error as string).toContain("Unknown space_id");
    expect(res.data.accepted as string[]).toContain(lecture.id);
  });

  it("refuses a write in the space whose role lacks it, naming where it is granted", async () => {
    const described = payload(
      await call("describe_operation", { operation_id: "createAgent", space_id: defaultSpaceId }),
    );
    expect(described.data.granted).toBe(false);
    expect(described.data.granted_in).toEqual([gestion.id]);
    expect(described.data.hint as string).toContain(NO_FALLBACK_FRAGMENT);

    const refused = payload(
      await call("invoke_operation", {
        operation_id: "createAgent",
        space_id: defaultSpaceId,
        body: {},
      }),
    );
    expect(refused.isError).toBe(true);
    expect(refused.data.status).toBe(403);
    expect(refused.data.code).toBe("not_granted");
    expect(refused.data.granted_in).toEqual([gestion.id]);
    expect(refused.data.hint as string).toContain(NO_FALLBACK_FRAGMENT);

    // The same write named in Gestion passes the guard (the empty body is the
    // route's own 400, after the permission).
    const allowed = payload(
      await call("invoke_operation", {
        operation_id: "createAgent",
        space_id: gestion.id,
        body: {},
      }),
    );
    expect(allowed.data.status).not.toBe(403);
    expect((allowed.data.space as { id: string }).id).toBe(gestion.id);
  });

  it("hands run_and_wait its arguments without space_id, so the launch reaches the route", async () => {
    const res = await call("run_and_wait", {
      kind: "agent",
      scope: "@nobody",
      name: "missing",
      space_id: gestion.id,
    });
    // Not the launcher's own unknown-argument refusal: the route answered.
    expect(res.error).toBeUndefined();
    const launched = payload(res);
    expect(launched.isError).toBe(true);
    expect(JSON.stringify(launched.data)).not.toContain("space_id");
    expect(launched.data.status).toBe(404);
    // A failed launch names its space too: the model must not look for the agent elsewhere unasked.
    expect((launched.data.space as { id: string }).id).toBe(gestion.id);
  });

  it("applies the role the admission read, not the listing's, to the tool's own grant", async () => {
    // Demoted to viewer between the listing and the admission of this request.
    const listSpaces = spacesService.listSpacesForPrincipal;
    const spy = spyOn(spacesService, "listSpacesForPrincipal").mockImplementation(
      async (...args) => {
        const listed = await listSpaces(...args);
        await db
          .update(spaceMembers)
          .set({ presetRole: "viewer" })
          .where(and(eq(spaceMembers.spaceId, gestion.id), eq(spaceMembers.userId, callerId)));
        return listed;
      },
    );
    try {
      const res = payload(
        await call("invoke_operation", { operation_id: "listAgents", space_id: gestion.id }),
      );
      expect(res.isError).toBe(true);
      expect(res.data.error as string).toContain("Gestion");
    } finally {
      spy.mockRestore();
    }
  });

  it("re-checks the tool's own grant in the space named: a viewer cannot invoke", async () => {
    const res = payload(
      await call("invoke_operation", { operation_id: "listAgents", space_id: lecture.id }),
    );
    expect(res.isError).toBe(true);
    expect(res.data.error as string).toContain("Lecture");
    expect(res.data.granted_in as string[]).toContain(gestion.id);
    expect(res.data.granted_in as string[]).not.toContain(lecture.id);
  });

  it("answers search for the space named, a denied row naming where it is granted", async () => {
    const res = payload(
      await call("search_operations", { query: "createAgent", limit: 5, space_id: defaultSpaceId }),
    );
    const row = (res.data.denied as Array<{ operation_id: string; granted_in?: string[] }>).find(
      (op) => op.operation_id === "createAgent",
    );
    expect(row?.granted_in).toEqual([gestion.id]);

    // Granted in every reachable space: no `granted_in` at all, as in the index.
    const everywhere = payload(
      await call("search_operations", { query: "listAgents", limit: 5, space_id: gestion.id }),
    );
    const listed = (
      everywhere.data.operations as Array<{ operation_id: string; granted_in?: string[] }>
    ).find((op) => op.operation_id === "listAgents");
    expect(listed).toBeDefined();
    expect(listed!.granted_in).toBeUndefined();
  });

  it("re-checks kind:inline as its own act: an operator runs agents, not inline runs", async () => {
    const res = payload(
      await call("run_and_wait", {
        kind: "inline",
        prompt: "noop",
        space_id: defaultSpaceId,
      }),
    );
    expect(res.isError).toBe(true);
    expect(res.data.error as string).toContain('kind:"inline"');
    expect(res.data.granted_in).toEqual([gestion.id]);
  });

  it("refuses a caller who reaches no space, rather than landing on the default one", async () => {
    const owner = await createTestContext();
    const guest = await memberContext(owner, "guest");
    const { status } = await rpc(
      { Cookie: guest.cookie, "X-Org-Id": owner.orgId },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );
    expect(status).toBe(403);
  });

  it("is the same schema for a caller who reaches a single space", async () => {
    const owner = await createTestContext();
    const solo = await memberContext(owner, "member");
    const only = await seedSpace({ orgId: owner.orgId, name: "Solo", visibility: "closed" });
    await seedSpaceMember({ spaceId: only.id, userId: solo.user.id, presetRole: "admin" });
    const soloHeaders = { Cookie: solo.cookie, "X-Org-Id": owner.orgId };

    const missing = payload(
      await call("invoke_operation", { operation_id: "listAgents" }, soloHeaders),
    );
    expect(missing.isError).toBe(true);
    expect(missing.data.code).toBe("missing_argument");
    expect(missing.data.error as string).toContain("space_id is required");
    expect(missing.data.accepted as string[]).toContain(only.id);

    const named = payload(
      await call(
        "invoke_operation",
        { operation_id: "listAgents", space_id: only.id },
        soloHeaders,
      ),
    );
    expect(named.data.status).toBe(200);
    expect((named.data.space as { id: string }).id).toBe(only.id);
  });

  /** POST to the space-pinned URL `/api/mcp/o/:org/s/:space`. */
  const atUrl = async (space: string, message: Record<string, unknown>, h = headers) => {
    const res = await app.request(`/api/mcp/o/${h["X-Org-Id"]}/s/${space}`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify(message),
    });
    const text = await res.text();
    return { status: res.status, envelope: (text ? JSON.parse(text) : {}) as JsonRpcEnvelope };
  };
  const listAgents = { name: "invoke_operation", arguments: { operation_id: "listAgents" } };

  it("pins a connection by its URL: no space_id, every call in that space", async () => {
    const listed = await atUrl(gestion.id, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const invoke = (
      listed.envelope.result?.tools as Array<{
        name: string;
        inputSchema: { properties?: Record<string, unknown> };
      }>
    ).find((t) => t.name === "invoke_operation");
    expect(invoke?.inputSchema.properties?.space_id).toBeUndefined();

    // Operator in the default space, admin in Gestion: the URL decides.
    const { envelope } = await atUrl(gestion.id, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "invoke_operation", arguments: { operation_id: "createAgent", body: {} } },
    });
    expect(payload(envelope).data.status).not.toBe(403);

    // The URL decides: a `space_id` is not an argument there.
    const named = await atUrl(gestion.id, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "invoke_operation",
        arguments: { operation_id: "listAgents", space_id: defaultSpaceId },
      },
    });
    const refusal = payload(named.envelope);
    expect(refusal.isError).toBe(true);
    expect(refusal.data.code).toBe("unknown_argument");
    expect(refusal.data.arguments).toEqual(["space_id"]);
    expect(refusal.data.error as string).toContain("Unknown argument(s): space_id");
    expect(refusal.data.hint as string).toContain("pinned");
  });

  it("refuses a URL naming a space the caller holds no role in", async () => {
    const { status } = await atUrl(foreign.id, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: listAgents,
    });
    expect(status).toBe(403);
  });

  it("refuses a URL space that is not the API key's space", async () => {
    const key = await seedApiKey({
      orgId: headers["X-Org-Id"]!,
      spaceId: defaultSpaceId,
      createdBy: callerId,
      scopes: ["mcp:read", "mcp:invoke", "agents:read"],
    });
    const keyHeaders = { Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": headers["X-Org-Id"]! };
    const agree = await atUrl(
      defaultSpaceId,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: listAgents },
      keyHeaders,
    );
    expect(payload(agree.envelope).data.status).toBe(200);
    const disagree = await atUrl(
      gestion.id,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: listAgents },
      keyHeaders,
    );
    expect(disagree.status).toBe(403);
  });

  it("describes the space-pinned URL with the space's own resource", async () => {
    const org = headers["X-Org-Id"]!;
    const res = await app.request(
      `/.well-known/oauth-protected-resource/api/mcp/o/${org}/s/${gestion.id}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe(`${APP_BASE}/api/mcp/o/${org}/s/${gestion.id}`);
  });

  it("names two spaces with the same name by their ids", async () => {
    const orgId = headers["X-Org-Id"]!;
    const twin = await seedSpace({ orgId, name: "Gestion", visibility: "closed" });
    await seedSpaceMember({ spaceId: twin.id, userId: callerId, presetRole: "admin" });

    const refused = payload(
      await call("invoke_operation", {
        operation_id: "createAgent",
        space_id: defaultSpaceId,
        body: {},
      }),
    );
    expect(refused.data.code).toBe("not_granted");
    expect([...(refused.data.granted_in as string[])].sort()).toEqual([gestion.id, twin.id].sort());
  });
});

const NO_FALLBACK_FRAGMENT = "Do not retry this action in another space";
