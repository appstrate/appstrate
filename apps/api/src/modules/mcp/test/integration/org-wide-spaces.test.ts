// SPDX-License-Identifier: Apache-2.0

/**
 * An unpinned connection reaches every space where the caller holds a role
 * (`docs/plans/mcp-org-wide-spaces.md`). The caller here is `operator` in the
 * default space, `admin` in "Gestion" and `viewer` in "Lecture": three roles,
 * so an operation allowed in one space is refused in another.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import { createTestContext, memberContext } from "../../../../../test/helpers/auth.ts";
import { seedSpace, seedSpaceMember } from "../../../../../test/helpers/seed.ts";
import { mcpRpc, type JsonRpcEnvelope } from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";

const app = getTestApp();
await registerTestPlatformApp();
const rpc = mcpRpc(app);

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

  beforeEach(async () => {
    await truncateAll();
    const owner = await createTestContext();
    const caller = await memberContext(owner, "member", "operator");
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

  it("lists the reachable spaces in get_me and in the instructions", async () => {
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
    expect(instructions).toContain(gestion.id);
    expect(instructions).toContain(NO_FALLBACK_FRAGMENT);
    // Roles differ: an operation granted in some spaces only names them, under its own tag.
    expect(instructions).toContain("createAgent [Gestion]");
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

    // A tool some spaces grant names them; one every space grants names none.
    const described = (name: string) =>
      (tools.find((t) => t.name === name) as { description?: string } | undefined)?.description;
    const invoke = described("invoke_operation")!;
    expect(invoke).toContain("Available in:");
    expect(invoke).toContain("Gestion");
    expect(invoke).not.toContain("Lecture");
    expect(described("read_skill")).not.toContain("Available in:");
  });

  it("requires space_id on a read as on a write, and names the space read", async () => {
    const res = await call("invoke_operation", { operation_id: "listAgents" });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("space_id is required");
    expect(res.error?.message).toContain(defaultSpaceId);

    const inGestion = payload(
      await call("invoke_operation", { operation_id: "listAgents", space_id: gestion.id }),
    );
    expect((inGestion.data.space as { id: string }).id).toBe(gestion.id);
  });

  it("requires space_id on a write", async () => {
    const res = await call("invoke_operation", { operation_id: "createAgent", body: {} });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("space_id is required");
    expect(res.error?.message).toContain(gestion.id);
  });

  it("refuses a space the caller does not reach, listing the ones it does", async () => {
    const res = await call("invoke_operation", {
      operation_id: "listAgents",
      space_id: foreign.id,
    });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("Unknown space_id");
    expect(res.error?.message).toContain(lecture.id);
  });

  it("refuses a write in the space whose role lacks it, naming where it is granted", async () => {
    const described = payload(
      await call("describe_operation", { operation_id: "createAgent", space_id: defaultSpaceId }),
    );
    expect(described.data.granted).toBe(false);
    expect(described.data.granted_in).toEqual(["Gestion"]);

    const refused = payload(
      await call("invoke_operation", {
        operation_id: "createAgent",
        space_id: defaultSpaceId,
        body: {},
      }),
    );
    expect(refused.isError).toBe(true);
    expect(refused.data.status).toBe(403);
    expect(refused.data.granted_in).toEqual(["Gestion"]);
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
  });

  it("re-checks the tool's own grant in the space named: a viewer cannot invoke", async () => {
    const res = payload(
      await call("invoke_operation", { operation_id: "listAgents", space_id: lecture.id }),
    );
    expect(res.isError).toBe(true);
    expect(res.data.error as string).toContain("Lecture");
    expect(res.data.granted_in as string[]).toContain("Gestion");
    expect(res.data.granted_in as string[]).not.toContain("Lecture");
  });

  it("answers search for the space named, a denied row naming where it is granted", async () => {
    const res = payload(
      await call("search_operations", { query: "createAgent", limit: 5, space_id: defaultSpaceId }),
    );
    const row = (res.data.denied as Array<{ operation_id: string; granted_in?: string[] }>).find(
      (op) => op.operation_id === "createAgent",
    );
    expect(row?.granted_in).toEqual(["Gestion"]);

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

  it("is the same schema for a caller who reaches a single space", async () => {
    const owner = await createTestContext();
    const solo = await memberContext(owner, "member");
    const only = await seedSpace({ orgId: owner.orgId, name: "Solo", visibility: "closed" });
    await seedSpaceMember({ spaceId: only.id, userId: solo.user.id, presetRole: "admin" });
    const soloHeaders = { Cookie: solo.cookie, "X-Org-Id": owner.orgId };

    const missing = await call("invoke_operation", { operation_id: "listAgents" }, soloHeaders);
    expect(missing.error?.code).toBe(-32602);
    expect(missing.error?.message).toContain("space_id is required");

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

  it("keeps an X-Space-Id connection pinned: no space_id argument", async () => {
    const pinned = { ...headers, "X-Space-Id": gestion.id };
    const { envelope } = await rpc(pinned, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const invoke = (
      envelope.result?.tools as Array<{
        name: string;
        inputSchema: { properties?: Record<string, unknown> };
      }>
    ).find((t) => t.name === "invoke_operation");
    expect(invoke?.inputSchema.properties?.space_id).toBeUndefined();

    const res = await call(
      "invoke_operation",
      { operation_id: "listAgents", space_id: defaultSpaceId },
      pinned,
    );
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("Unknown argument(s): space_id");
  });
});

const NO_FALLBACK_FRAGMENT = "Do not retry this action in another space";
