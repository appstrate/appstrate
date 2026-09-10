// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the MCP server `instructions` string — specifically the
 * connect bullet, which is the only place an MCP client is told how to act on a
 * readiness failure (#1207).
 *
 * Prose is not the contract and is not pinned here. Only the tokens a model
 * branches on are: the STATUS it must recognize (412, never 400), the field it
 * must read before reaching for a tool (`connect_url`), the operation and the
 * argument the fallback kickoff must carry (`initiateIntegrationConnect` with
 * `scopes` = the item's `required_scopes`), and the one thing that differs
 * between the two client kinds — delivery.
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
  it("names the readiness refusal as a 412 and never as a 400", () => {
    // The readiness envelope is `412 missing_integration_connection`
    // (services/agent-readiness.ts); a model told to expect a 400 treats the
    // 412 as an unknown failure and gives up instead of connecting.
    for (const contextInjected of [false, true]) {
      const bullet = connectBullet(contextInjected);
      expect(bullet).toMatch(/\b412\b/);
      expect(bullet).not.toMatch(/\b400\b/);
    }
  });

  it("points at the item's own `connect_url` before the kickoff tool", () => {
    // An item that already carries a link is a finished offer; calling the
    // kickoff anyway mints a second capability and asks for consent twice.
    for (const contextInjected of [false, true]) {
      const bullet = connectBullet(contextInjected);
      expect(bullet).toMatch(/FIRST[^.]*`connect_url`/);
      expect(bullet.indexOf("connect_url")).toBeLessThan(
        bullet.indexOf("initiateIntegrationConnect"),
      );
    }
  });

  it("binds the fallback kickoff's `scopes` to the item's `required_scopes`", () => {
    // Without the relay the consent re-grants the same insufficient set, and
    // `connection_id` is what keeps a reconnect on the existing row.
    const bullet = connectBullet(false);
    expect(bullet).toContain("initiateIntegrationConnect");
    expect(bullet).toMatch(/scopes: <[^>]*required_scopes/);
    expect(bullet).toMatch(/connection_id: <[^>]*connection_id/);
  });

  it("differs between the two client kinds on delivery only", () => {
    // The chat renders the connect card from the tool result itself, so the
    // model restating the link duplicates it; an external client has no card,
    // so there the model must hand the URL over.
    const chat = connectBullet(true);
    const external = connectBullet(false);
    expect(chat).toContain("do NOT paste the link");
    expect(external).not.toContain("do NOT paste the link");
    expect(external).toMatch(/Give the caller that `connect_url`/);
    expect(chat).not.toMatch(/Give the caller that `connect_url`/);
    // Behaviour-shaping, not wording: dropping it turns a 412 into a poll loop.
    for (const bullet of [chat, external]) {
      expect(bullet).toMatch(/do NOT poll, loop, wait/);
      expect(bullet).toMatch(/authKey: "<the error's auth_key/);
    }
  });
});
