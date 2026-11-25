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
});
