// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the MCP server `instructions` string: the connect bullet —
 * the only place an MCP client is told how to act on a readiness failure
 * (#1207) — and the agent-authoring guidance gated on `agents:write`.
 *
 * Prose is not the contract. Only the tokens a model branches on are pinned:
 * the STATUS it must recognize (412, never 400), the field it must read before
 * reaching for a tool (`connect_url`), the operation and the argument the
 * fallback kickoff must carry (`initiateIntegrationConnect` with `scopes` = the
 * item's `required_scopes`), the one thing that differs between the two client
 * kinds — delivery — and whether authoring guidance is present at all.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { buildServerInstructions } from "../../router.ts";
import { OPERATION_INDEX_HEADING } from "@appstrate/core/chat-contract";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { resetCatalog } from "../../catalog.ts";

// The appended operation index is filtered per operation against the mounted
// guards, so building the instructions reads the route table.
await registerTestPlatformApp();

/**
 * Launch and read back: the connect bullet is run-readiness guidance, so it is
 * only written for a caller who can get a run off the ground (`canRunAgents`).
 */
const permissions = new Set(["mcp:read", "mcp:invoke", "agents:run", "runs:read"]);

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
  beforeEach(() => resetCatalog());

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

describe("MCP server instructions — run guidance", () => {
  beforeEach(() => resetCatalog());

  // Rule 1: an act the caller's set makes structurally impossible is ABSENT,
  // not contradicted. `run_and_wait` is declared on `canRunAgents`, so every
  // paragraph that teaches running goes with it — dropping that gate makes
  // each of these three markers reappear for the caller below.
  const RUNNER = new Set(["mcp:read", "mcp:invoke", "agents:run", "runs:read"]);
  const NO_RUN = new Set(["mcp:read", "mcp:invoke"]);

  /** Prose only — the appended operation index would match on its own. */
  function prose(caller: ReadonlySet<string>): string {
    const instructions = buildServerInstructions(caller, true);
    return instructions.slice(0, instructions.indexOf(OPERATION_INDEX_HEADING));
  }

  it("teaches run_and_wait, async runs and connect-before-run only to a caller who can run", () => {
    const withRuns = prose(RUNNER);
    const without = prose(NO_RUN);
    for (const marker of [
      "run_and_wait",
      "Runs are asynchronous",
      "Shortcut —",
      "Connecting or reconnecting an integration before a run",
      "must_choose_connection",
    ]) {
      expect(withRuns).toContain(marker);
      expect(without).not.toContain(marker);
    }
  });

  it("keeps the integration-preference bullet for both — it stands on its own", () => {
    // The negative control for the case above: the run prose disappearing is a
    // targeted removal, not the whole "Beyond the per-operation schemas"
    // section going missing.
    expect(prose(RUNNER)).toContain("- Integration preference");
    expect(prose(NO_RUN)).toContain("- Integration preference");
  });
});

describe("MCP server instructions — agent authoring", () => {
  beforeEach(() => resetCatalog());

  it("teaches tool selection and `dependencies.*` only to a caller holding `agents:write`", () => {
    const withWrite = buildServerInstructions(
      new Set(["mcp:read", "mcp:invoke", "agents:write"]),
      true,
    );
    const without = buildServerInstructions(permissions, true);
    expect(withWrite).toContain("Integration tool selection");
    expect(withWrite).toContain("building or configuring an agent");
    expect(without).not.toContain("Integration tool selection");
    expect(without).not.toContain("building or configuring an agent");
  });

  it("withholds it from a caller who may author but not invoke", () => {
    // Authoring an agent is `createAgent` through `invoke_operation`: a
    // discovery-only caller cannot act on manifest guidance, so it is absent
    // rather than taught and then refused.
    const cannotInvoke = buildServerInstructions(new Set(["mcp:read", "agents:write"]), true);
    expect(cannotInvoke).not.toContain("Integration tool selection");
    expect(cannotInvoke).not.toContain("building or configuring an agent");
  });
});
