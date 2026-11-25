// SPDX-License-Identifier: Apache-2.0

/**
 * McpHost gates the undeclared tools of a closed catalog on the fingerprint of their RAW
 * definition, and reports what the agent selected but cannot call.
 */

import { describe, it, expect } from "bun:test";
import {
  createInProcessPair,
  toolDefinitionFingerprint,
  wrapClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import { fnv1a64Hex } from "@appstrate/afps-shared/mcp-naming";
import { McpHost } from "../mcp-host.ts";

const CONN = { label: "work", accountId: null };

function tool(name: string, description: string): AppstrateToolDefinition {
  return {
    descriptor: { name, description, inputSchema: { type: "object" } },
    handler: async () => ({ content: [{ type: "text", text: name }] }),
  };
}

async function register(
  tools: AppstrateToolDefinition[],
  extra: {
    allowedTools?: string[];
    hiddenTools?: string[];
    blockedTools?: string[];
    approvedToolFingerprints?: Record<string, string[]>;
  },
) {
  const pair = await createInProcessPair(tools);
  const host = new McpHost();
  const registration = await host.register({
    integrationId: "@scope/gh",
    namespace: "gh",
    connection: CONN,
    client: wrapClient(pair.client, { close: () => Promise.resolve() }),
    ...extra,
  });
  return { host, registration, close: () => pair.close() };
}

const exposed = (host: McpHost) =>
  host
    .buildTools()
    .map((t) => t.descriptor.name)
    .sort();

describe("McpHost — approvedToolFingerprints", () => {
  it("does not expose an undeclared tool whose fingerprint is not approved, and reports it", async () => {
    const live = tool("dangerous", "now does something else");
    const { host, registration, close } = await register([live, tool("safe", "ok")], {
      approvedToolFingerprints: { dangerous: ["0".repeat(64)] },
    });
    try {
      expect(exposed(host)).toEqual(["gh__safe"]);
      expect(registration.unavailable).toEqual([
        { name: "dangerous", reason: "definition_not_approved" },
      ]);
    } finally {
      await close();
    }
  });

  it("does not expose an undeclared tool nobody approved (empty list)", async () => {
    const { host, registration, close } = await register([tool("new_tool", "x")], {
      approvedToolFingerprints: { new_tool: [] },
    });
    try {
      expect(exposed(host)).toEqual([]);
      expect(registration.unavailable).toEqual([
        { name: "new_tool", reason: "definition_not_approved" },
      ]);
    } finally {
      await close();
    }
  });

  it("exposes an undeclared tool whose raw fingerprint is approved", async () => {
    const def = tool("extra", "approved definition");
    const pair = await createInProcessPair([def]);
    const raw = (await pair.client.listTools()).tools[0]!;
    await pair.close();
    const { host, registration, close } = await register([def], {
      approvedToolFingerprints: { extra: ["1".repeat(64), toolDefinitionFingerprint(raw)] },
    });
    try {
      expect(exposed(host)).toEqual(["gh__extra"]);
      expect(registration.unavailable).toEqual([]);
    } finally {
      await close();
    }
  });

  it("never gates a declared tool: no map entry, changed definition still exposed", async () => {
    const { host, registration, close } = await register([tool("declared", "changed")], {
      approvedToolFingerprints: { other_tool: [] },
    });
    try {
      expect(exposed(host)).toEqual(["gh__declared"]);
      expect(registration.unavailable).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("McpHost — approvedToolFingerprints keys are own properties only", () => {
  // Names that resolve on Object.prototype: a plain lookup would return a function or the prototype
  // itself and `.includes` would throw.
  for (const name of ["constructor", "__proto__", "toString"]) {
    it(`exposes a tool named ${name} that has no entry, without throwing`, async () => {
      const { host, registration, close } = await register([tool(name, "x"), tool("safe", "ok")], {
        approvedToolFingerprints: { other_tool: [] },
      });
      try {
        expect(exposed(host)).toEqual([`gh__${name}`, "gh__safe"].sort());
        expect(registration.unavailable).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`excludes a tool named ${name} whose own entry approves nothing`, async () => {
      const approved: Record<string, string[]> = {};
      Object.defineProperty(approved, name, {
        value: [],
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const { host, registration, close } = await register([tool(name, "x"), tool("safe", "ok")], {
        approvedToolFingerprints: approved,
      });
      try {
        expect(exposed(host)).toEqual(["gh__safe"]);
        expect(registration.unavailable).toEqual([{ name, reason: "definition_not_approved" }]);
      } finally {
        await close();
      }
    });
  }
});

describe("McpHost — unavailable report", () => {
  it("reports an allowlisted tool the listing did not return as not_listed", async () => {
    const { host, registration, close } = await register([tool("a", "a")], {
      allowedTools: ["a", "gone"],
    });
    try {
      expect(exposed(host)).toEqual(["gh__a"]);
      expect(registration.unavailable).toEqual([{ name: "gone", reason: "not_listed" }]);
      expect(registration.listed.map((t) => t.name)).toEqual(["a"]);
    } finally {
      await close();
    }
  });

  it("reports hidden_tools only for a tool the agent selected", async () => {
    const { registration, close } = await register(
      [tool("a", "a"), tool("b", "b"), tool("c", "c")],
      {
        allowedTools: ["a", "b"],
        hiddenTools: ["b", "c"],
      },
    );
    try {
      expect(registration.unavailable).toEqual([{ name: "b", reason: "hidden_tools" }]);
    } finally {
      await close();
    }
  });

  it("excludes blocked tools and reports blocked_in_space only for a selected one", async () => {
    const { host, registration, close } = await register(
      [tool("a", "a"), tool("b", "b"), tool("c", "c"), tool("d", "d")],
      { allowedTools: ["a", "b", "d"], hiddenTools: ["d"], blockedTools: ["b", "c", "d"] },
    );
    try {
      expect(exposed(host)).toEqual(["gh__a"]);
      expect(registration.unavailable).toEqual([
        { name: "b", reason: "blocked_in_space" },
        { name: "d", reason: "hidden_tools" },
      ]);
    } finally {
      await close();
    }
  });

  it("reports every allowlisted name as not_listed when the server does not advertise tools", async () => {
    const pair = await createInProcessPair([tool("a", "a")]);
    const client = wrapClient(pair.client, { close: () => Promise.resolve() });
    const noTools = new Proxy(client, {
      get(target, key) {
        if (key === "getServerCapabilities") return () => ({});
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      const registration = await new McpHost().register({
        integrationId: "@scope/gh",
        namespace: "gh",
        connection: CONN,
        client: noTools,
        allowedTools: ["a", "b"],
      });
      expect(registration.unavailable).toEqual([
        { name: "a", reason: "not_listed" },
        { name: "b", reason: "not_listed" },
      ]);
      expect(registration.listed).toEqual([]);
    } finally {
      await pair.close();
    }
  });

  describe("name_collision", () => {
    // `a.b` normalises to `a_b`; the three names below hold its plain name and both re-hashed ones.
    const squatters = [
      "a_b",
      `a_b_${fnv1a64Hex("a.b").slice(0, 8)}`,
      `a_b_${fnv1a64Hex("a.b\0").slice(0, 8)}`,
    ];
    const listing = () => [...squatters, "a.b"].map((name) => tool(name, name));

    it("reports a selected tool left without a free name", async () => {
      const { registration, close } = await register(listing(), {
        allowedTools: [...squatters, "a.b"],
      });
      try {
        expect(registration.unavailable).toEqual([{ name: "a.b", reason: "name_collision" }]);
      } finally {
        await close();
      }
    });

    it("reports nothing when the selection is open: nobody selected the tool", async () => {
      const { registration, close } = await register(listing(), {});
      try {
        expect(registration.unavailable).toEqual([]);
      } finally {
        await close();
      }
    });
  });
});

describe("McpHost — a name listed twice", () => {
  it("judges it once, on its first occurrence, and reports it once", async () => {
    const listed = [
      { name: "dup", description: "first", inputSchema: { type: "object" } },
      { name: "dup", description: "second", inputSchema: { type: "object" } },
    ];
    const client = {
      getServerVersion: () => undefined,
      getServerCapabilities: () => ({ tools: {} }),
      getProtocol: () => undefined,
      listTools: async () => ({ tools: listed }),
      callTool: async () => ({ content: [] }),
    } as unknown as Parameters<McpHost["register"]>[0]["client"];
    const approve = (host: McpHost) =>
      host.register({
        integrationId: "@scope/gh",
        namespace: "gh",
        connection: CONN,
        client,
        allowedTools: ["dup", "dup", "gone", "gone"],
        approvedToolFingerprints: { dup: [toolDefinitionFingerprint(listed[0] as never)] },
      });
    const host = new McpHost();
    const registration = await approve(host);
    expect(exposed(host)).toEqual(["gh__dup"]);
    expect(registration.unavailable).toEqual([{ name: "gone", reason: "not_listed" }]);

    // Approved only for the second definition: the first one decides, once.
    const other = new McpHost();
    const refused = await other.register({
      integrationId: "@scope/gh",
      namespace: "gh",
      connection: CONN,
      client,
      approvedToolFingerprints: { dup: [toolDefinitionFingerprint(listed[1] as never)] },
    });
    expect(exposed(other)).toEqual([]);
    expect(refused.unavailable).toEqual([{ name: "dup", reason: "definition_not_approved" }]);
  });
});
