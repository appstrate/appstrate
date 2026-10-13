// SPDX-License-Identifier: Apache-2.0

/**
 * An agent's tool call never names a login input's `{{key}}` placeholder: the runner's MITM
 * listener would substitute the login secret into the request that call makes.
 */

import { describe, it, expect } from "bun:test";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { refuseLoginPlaceholders } from "../integrations-boot.ts";

function recordingClient() {
  const calls: unknown[] = [];
  const ok: CallToolResult = { content: [{ type: "text", text: "fine" }] };
  const client = {
    callTool: async (args: unknown) => {
      calls.push(args);
      return ok;
    },
  } as unknown as AppstrateMcpClient;
  return { client: refuseLoginPlaceholders(client, ["password", "otp"]), calls, ok };
}

describe("refuseLoginPlaceholders", () => {
  it.each([
    ["a top-level value", { query: "{{password}}" }],
    ["a nested value", { filter: { any: [{ text: "x {{otp}} y" }] } }],
    ["an array item", { ids: ["a", "{{password}}"] }],
    ["a property name", { "{{password}}": 1 }],
  ])("refuses a call naming a login input in %s, without reaching the runner", async (_, args) => {
    const { client, calls } = recordingClient();
    const result = await client.callTool({ name: "search", arguments: args });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    // The refusal names the placeholder, never a value.
    expect(JSON.stringify(result.content)).toMatch(/\{\{(password|otp)\}\}/);
  });

  it("passes a call naming no login input, another placeholder included", async () => {
    const { client, calls, ok } = recordingClient();
    for (const args of [
      {},
      { query: "password" },
      { query: "{{username}}" },
      { q: "{password}" },
    ]) {
      expect(await client.callTool({ name: "search", arguments: args })).toBe(ok);
    }
    expect(await client.callTool({ name: "login" })).toBe(ok);
    expect(calls).toHaveLength(5);
  });
});
