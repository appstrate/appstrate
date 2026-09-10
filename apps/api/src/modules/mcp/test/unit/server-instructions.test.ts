// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the MCP server `instructions` string — specifically the
 * connect bullet, which is the only place an MCP client is told how to act on a
 * readiness failure (#1207).
 *
 * Three things it must state and used to get wrong: the preflight refuses with
 * 412 (not 400); an error item that already carries a `connect_url` is a
 * finished offer, not a reason to call another tool; and the fallback kickoff
 * must relay the error's `required_scopes` / `auth_key` / `connection_id`,
 * without which the consent re-grants the same insufficient scope set.
 */

import { describe, it, expect } from "bun:test";
import { buildServerInstructions } from "../../router.ts";

const permissions = new Set(["mcp:read"]);

/** The connect bullet only — asserting on the whole prompt would match the index. */
function connectBullet(contextInjected: boolean): string {
  const instructions = buildServerInstructions(permissions, contextInjected);
  const start = instructions.indexOf("- Connecting or reconnecting an integration before a run");
  const end = instructions.indexOf("\n- The exception —", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return instructions.slice(start, end);
}

describe("MCP server instructions — connect bullet", () => {
  it("names the readiness refusal as a 412", () => {
    // The readiness envelope is `412 missing_integration_connection`
    // (services/agent-readiness.ts); a model told to expect a 400 treats the
    // 412 as an unknown failure and gives up instead of connecting.
    const bullet = connectBullet(false);
    expect(bullet).toContain("returns a 412 without consuming credits");
    expect(bullet).not.toContain("returns a 400 without consuming credits");
  });

  it("puts the `connect_url` check first, ahead of any tool call", () => {
    for (const contextInjected of [false, true]) {
      const bullet = connectBullet(contextInjected);
      expect(bullet).toContain("looking FIRST for a `connect_url` on the item");
      expect(bullet).toContain("do NOT call `initiateIntegrationConnect`");
      expect(bullet).toContain("do NOT call any other tool");
    }
  });

  it("relays auth_key, required_scopes and connection_id on the fallback kickoff", () => {
    const bullet = connectBullet(false);
    expect(bullet).toContain('operation_id: "initiateIntegrationConnect"');
    expect(bullet).toContain("authKey: \"<the error's auth_key");
    expect(bullet).toContain("scopes: <the error's required_scopes, verbatim>");
    expect(bullet).toContain("connection_id: <the error's connection_id");
  });

  it("tells a chat client the card is rendered for it and must not be restated", () => {
    const bullet = connectBullet(true);
    expect(bullet).toContain("The client renders the connect button from this result on its own");
    expect(bullet).toContain("do NOT paste the link");
    expect(bullet).toContain("do NOT poll, loop, wait, or run in the same turn");
    // No card on the other side of the boundary — the chat model must not be
    // told to hand the URL over.
    expect(bullet).not.toContain("Give the caller that `connect_url` to open");
  });

  it("tells an external MCP client to hand the connect_url over instead", () => {
    const bullet = connectBullet(false);
    expect(bullet).toContain("Give the caller that `connect_url` to open");
    expect(bullet).toContain("do NOT poll, loop, wait, or run in the same turn");
    expect(bullet).not.toContain("The client renders the connect button");
    // The delivery sentence replaced the old parenthetical aimed at
    // non-interactive clients; keeping both would say it twice.
    expect(bullet).not.toContain("Non-interactive clients with no button");
  });
});
