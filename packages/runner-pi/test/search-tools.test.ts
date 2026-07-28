// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the search-tool widening (`enableSearchTools`).
 *
 * Production shape being defended: the Pi SDK registers seven built-ins but
 * activates four, so an agent asked to explore a workspace reaches for `bash`
 * (`grep -rn …`, `sed -n 'A,Bp'`) on every lookup. Widening the active set is
 * only safe if it stays ADDITIVE — the extension / MCP / integration tools live
 * in the same active set, and `setActiveToolsByName` replaces it wholesale.
 */

import { describe, it, expect } from "bun:test";
import { enableSearchTools, SEARCH_TOOL_NAMES } from "../src/pi-runner.ts";
import { createFakeSession } from "./helpers.ts";

/** The four the SDK switches on by default (`core/sdk.js` → `defaultActiveToolNames`). */
const PI_DEFAULT_ACTIVE = ["read", "bash", "edit", "write"];
/** The seven the SDK registry knows (`core/tools/index.js` → `allToolNames`). */
const PI_BUILTINS = [...PI_DEFAULT_ACTIVE, "grep", "find", "ls"];

describe("enableSearchTools", () => {
  it("targets grep, find and ls", () => {
    expect([...SEARCH_TOOL_NAMES]).toEqual(["grep", "find", "ls"]);
  });

  it("adds the search tools the SDK registry exposes", () => {
    const session = createFakeSession({
      toolRegistry: PI_BUILTINS,
      activeTools: PI_DEFAULT_ACTIVE,
    });

    enableSearchTools(session);

    expect(session.setActiveToolsCalls).toHaveLength(1);
    expect(new Set(session.activeTools)).toEqual(new Set(PI_BUILTINS));
  });

  it("preserves already-active extension / MCP tool names", () => {
    // The regression this guards: `setActiveToolsByName` REPLACES the active
    // set, so a widening that passed only the search tools would strip every
    // Appstrate runtime + integration tool off the surface.
    const extensionTools = ["output", "publish_document", "gmail__api_call"];
    const session = createFakeSession({
      toolRegistry: [...PI_BUILTINS, ...extensionTools],
      activeTools: [...PI_DEFAULT_ACTIVE, ...extensionTools],
    });

    enableSearchTools(session);

    for (const name of [...PI_DEFAULT_ACTIVE, ...extensionTools]) {
      expect(session.activeTools).toContain(name);
    }
    expect(session.activeTools.length).toBeGreaterThan(PI_DEFAULT_ACTIVE.length);
  });

  it("skips names the registry does not expose rather than passing a droppable name", () => {
    // `setActiveToolsByName` silently drops unresolvable names, so an unknown
    // name is not an error — it is an invisible no-op. Probing keeps the
    // requested set honest.
    const session = createFakeSession({
      toolRegistry: [...PI_DEFAULT_ACTIVE, "grep"],
      activeTools: PI_DEFAULT_ACTIVE,
    });

    enableSearchTools(session);

    expect(session.setActiveToolsCalls[0]).toContain("grep");
    expect(session.setActiveToolsCalls[0]).not.toContain("find");
    expect(session.setActiveToolsCalls[0]).not.toContain("ls");
  });

  it("never shrinks the active set", () => {
    const session = createFakeSession({
      toolRegistry: [...PI_DEFAULT_ACTIVE, "output"],
      activeTools: [...PI_DEFAULT_ACTIVE, "output"],
    });
    const before = [...session.activeTools];

    enableSearchTools(session);

    for (const name of before) expect(session.activeTools).toContain(name);
    expect(session.activeTools.length).toBeGreaterThanOrEqual(before.length);
  });

  it("does not duplicate a search tool that is already active", () => {
    const session = createFakeSession({
      toolRegistry: PI_BUILTINS,
      activeTools: [...PI_DEFAULT_ACTIVE, "grep"],
    });

    enableSearchTools(session);

    const requested = session.setActiveToolsCalls[0]!;
    expect(requested.filter((name) => name === "grep")).toHaveLength(1);
    expect(new Set(requested).size).toBe(requested.length);
  });

  it("does not touch the session when every search tool is already active", () => {
    // The rewrite is free only before the first prompt; a redundant one
    // mid-session would invalidate the Anthropic prompt-cache prefix for nothing.
    const session = createFakeSession({ toolRegistry: PI_BUILTINS, activeTools: PI_BUILTINS });

    enableSearchTools(session);

    expect(session.setActiveToolsCalls).toHaveLength(0);
  });

  it("widens before the first prompt, without consuming a turn", () => {
    // Mirrors the production sequence in `PiRunner.executeSession`: widen right
    // after `createAgentSession`, then prompt. Asserts the two observable
    // properties of that ordering — the widening issues no prompt of its own,
    // and the first turn already sees the search tools.
    const session = createFakeSession({
      toolRegistry: PI_BUILTINS,
      activeTools: PI_DEFAULT_ACTIVE,
    });

    enableSearchTools(session);
    void session.prompt("do the task");

    expect(session.callLog).toEqual(["set_active_tools", "prompt"]);
    expect(session.prompts).toHaveLength(1);
    expect(session.activeToolsAtPrompt[0]).toEqual(expect.arrayContaining(["grep", "find", "ls"]));
  });
});
