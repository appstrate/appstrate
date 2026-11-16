// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  buildLogEntries,
  buildTurnRows,
  filterJournal,
  journalGroupElapsedMs,
  journalIntegrationIds,
  journalLevel,
  expandedJournalGroups,
  journalRows,
  journalSearchText,
  toolLabel,
  type ExecutionEntry,
  type JournalFilters,
  type JournalRow,
  type RawLog,
  type ToolExecutionEntry,
} from "../log-utils";

function entryLabel(entry: ExecutionEntry): string {
  return entry.kind === "tool" ? `Tool: ${entry.tool}` : entry.message;
}

function toolEntry(entries: ExecutionEntry[], index = 0): ToolExecutionEntry {
  const entry = entries[index];
  expect(entry?.kind).toBe("tool");
  if (!entry || entry.kind !== "tool") throw new Error(`entry ${index} is not a tool`);
  return entry;
}

/** Minimal well-formed per-turn breadcrumb, as the runner emits it. */
function turnLog(data: Record<string, unknown>): RawLog {
  return { type: "progress", level: "debug", event: "progress", message: "Turn 1 — …", data };
}

describe("buildLogEntries — output extraction", () => {
  it("merges output events into the structured output bag", () => {
    const logs: RawLog[] = [
      { type: "result", level: "info", event: "output", data: { foo: 1 } },
      { type: "result", level: "info", event: "output", data: { bar: 2 } },
    ];
    const { output } = buildLogEntries(logs);
    expect(output).toEqual({ foo: 1, bar: 2 });
  });

  it("returns null output when no output events are present", () => {
    const logs: RawLog[] = [{ type: "progress", level: "debug", message: "hi" }];
    const { output } = buildLogEntries(logs);
    expect(output).toBeNull();
  });
});

describe("buildLogEntries — progress entry projection", () => {
  it("keeps consecutive agent logs as separate viewer rows", () => {
    const agentText = (message: string): RawLog => ({
      type: "progress",
      level: "debug",
      message,
      data: { event: "assistant_message" },
    });
    const { entries } = buildLogEntries([
      agentText("line one"),
      agentText("line two"),
      agentText("line three"),
    ]);
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.kind === "agent")).toBe(true);
    expect(entries.map(entryLabel)).toEqual(["line one", "line two", "line three"]);
  });

  it("projects an untagged progress row as a runtime breadcrumb, not agent prose", () => {
    // `appstrate.progress` is the canonical runner LIFECYCLE breadcrumb; only
    // `data.event = "assistant_message"` marks model-authored text. A runner
    // that stamps neither `data` nor a level lands here (the sink defaults the
    // level to `debug`), and claiming those words for the model would be a
    // misattribution.
    const { entries } = buildLogEntries([{ type: "progress", level: "debug", message: "running" }]);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "runtime", sourceType: "progress", message: "running" }),
    ]);
  });

  it("keeps data-bearing progress events as distinct entries (boot breadcrumbs)", () => {
    // The runtime-pi boot breadcrumbs carry `data` (at least `{ boot: true }`)
    // and their own level; each is a discrete phase marker, so each keeps its
    // own row rather than being folded into the one before it.
    const logs: RawLog[] = [
      { type: "progress", level: "info", message: "connecting to sidecar", data: { boot: true } },
      { type: "progress", level: "info", message: "MCP connected", data: { boot: true } },
    ];
    const { entries } = buildLogEntries(logs);
    expect(entries).toHaveLength(2);
    expect(entries.map(entryLabel)).toEqual(["connecting to sidecar", "MCP connected"]);
    expect(entries.every((entry) => entry.kind === "runtime")).toBe(true);
  });
});

describe("buildLogEntries — tool durations", () => {
  it("carries `data.durationMs` onto the tool-result entry", () => {
    const logs: RawLog[] = [
      {
        type: "progress",
        level: "debug",
        message: "Tool: read",
        data: { tool: "read", result: "ok", isError: false, durationMs: 1450 },
      },
    ];
    const { entries } = buildLogEntries(logs);
    expect(toolEntry(entries).durationMs).toBe(1450);
  });

  it("omits the duration when the runner could not pair the call", () => {
    // The runner emits NO `durationMs` rather than a zero when it never saw the
    // call's start — the entry must not invent one.
    const logs: RawLog[] = [
      {
        type: "progress",
        level: "debug",
        message: "Tool: read",
        data: { tool: "read", result: "ok", isError: false },
      },
    ];
    const { entries } = buildLogEntries(logs);
    expect(toolEntry(entries).durationMs).toBeUndefined();
  });

  it("ignores a non-numeric duration", () => {
    const logs: RawLog[] = [
      { type: "progress", level: "debug", message: "Tool: read", data: { durationMs: "fast" } },
    ];
    const { entries } = buildLogEntries(logs);
    expect(toolEntry(entries).durationMs).toBeUndefined();
  });
});

describe("buildLogEntries — correlated tool lifecycle", () => {
  it("projects a start + result as one tool entry that settles in place", () => {
    const logs: RawLog[] = [
      {
        id: 10,
        type: "progress",
        level: "debug",
        message: "Tool: read",
        data: { tool: "read", args: { path: "a.md" }, toolCallId: "call-1" },
      },
      {
        id: 11,
        type: "progress",
        level: "debug",
        message: "Tool result: read",
        data: {
          tool: "read",
          result: "contents",
          isError: false,
          toolCallId: "call-1",
          durationMs: 42,
        },
      },
    ];

    const { entries } = buildLogEntries(logs);
    expect(entries).toHaveLength(1);
    expect(toolEntry(entries)).toMatchObject({
      id: "tool:call-1",
      tool: "read",
      toolCallId: "call-1",
      status: "success",
      args: { path: "a.md" },
      result: "contents",
      durationMs: 42,
    });
    expect(toolEntry(entries)).not.toHaveProperty("orphaned");
  });

  it("keeps parallel calls distinct when their results settle out of order", () => {
    const logs: RawLog[] = [
      {
        type: "progress",
        level: "debug",
        message: "Tool: bash",
        data: { tool: "bash", args: { cmd: "slow" }, toolCallId: "slow" },
      },
      {
        type: "progress",
        level: "debug",
        message: "Tool: bash",
        data: { tool: "bash", args: { cmd: "fast" }, toolCallId: "fast" },
      },
      {
        type: "progress",
        level: "debug",
        message: "Tool result: bash",
        data: { tool: "bash", result: "fast done", isError: false, toolCallId: "fast" },
      },
      {
        type: "progress",
        level: "debug",
        message: "Tool error: bash",
        data: { tool: "bash", result: "slow failed", isError: true, toolCallId: "slow" },
      },
    ];

    const { entries } = buildLogEntries(logs);
    expect(entries).toHaveLength(2);
    expect(toolEntry(entries, 0)).toMatchObject({
      toolCallId: "slow",
      status: "failed",
      result: "slow failed",
    });
    expect(toolEntry(entries, 1)).toMatchObject({
      toolCallId: "fast",
      status: "success",
      result: "fast done",
    });
  });

  it("shows a loader live and marks an unmatched correlated start interrupted at terminal", () => {
    const logs: RawLog[] = [
      {
        type: "progress",
        level: "debug",
        message: "Tool: bash",
        data: { tool: "bash", args: {}, toolCallId: "call-1" },
      },
    ];

    expect(toolEntry(buildLogEntries(logs).entries).status).toBe("running");
    expect(toolEntry(buildLogEntries(logs, { isRunTerminal: true }).entries).status).toBe(
      "interrupted",
    );
  });

  it("does not guess a correlation for legacy rows without toolCallId", () => {
    const logs: RawLog[] = [
      {
        type: "progress",
        level: "debug",
        message: "Tool: bash",
        data: { tool: "bash", args: { cmd: "one" } },
      },
      {
        type: "progress",
        level: "debug",
        message: "Tool result: bash",
        data: { tool: "bash", result: "done", isError: false },
      },
    ];

    const { entries } = buildLogEntries(logs, { isRunTerminal: true });
    expect(entries).toHaveLength(2);
    expect(toolEntry(entries, 0).status).toBe("unknown");
    expect(toolEntry(entries, 1)).toMatchObject({ status: "success", orphaned: true });
  });

  it("recognises a result through isError even when the result value is undefined", () => {
    const { entries } = buildLogEntries([
      {
        type: "progress",
        level: "debug",
        message: "Tool result: noop",
        data: { tool: "noop", isError: false, toolCallId: "noop-1" },
      },
    ]);

    expect(toolEntry(entries)).toMatchObject({ status: "success", orphaned: true });
  });

  it("merges a late start into a result received first", () => {
    const { entries } = buildLogEntries([
      {
        type: "progress",
        level: "debug",
        message: "Tool result: read",
        data: { tool: "read", result: "contents", isError: false, toolCallId: "call-1" },
      },
      {
        type: "progress",
        level: "debug",
        message: "Tool: read",
        data: { tool: "read", args: { path: "a.md" }, toolCallId: "call-1" },
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(toolEntry(entries)).toMatchObject({
      status: "success",
      args: { path: "a.md" },
      result: "contents",
      orphaned: false,
    });
  });
});

describe("buildLogEntries — semantic kinds", () => {
  it("classifies tagged assistant text as a debug agent trace", () => {
    const { entries } = buildLogEntries([
      {
        type: "progress",
        level: "debug",
        message: "I will inspect the repository",
        data: { event: "assistant_message" },
      },
    ]);

    expect(entries).toEqual([
      expect.objectContaining({
        kind: "agent",
        level: "debug",
        message: "I will inspect the repository",
      }),
    ]);
  });

  it("keeps the explicit log tool output distinct from agent text", () => {
    const { entries } = buildLogEntries([
      {
        type: "progress",
        level: "info",
        event: "log",
        message: "User-visible progress",
      },
    ]);

    expect(entries).toEqual([
      expect.objectContaining({ kind: "log", level: "info", message: "User-visible progress" }),
    ]);
  });

  it("keeps a debug-level explicit log out of the generic runtime bucket", () => {
    const { entries } = buildLogEntries([
      {
        type: "progress",
        level: "debug",
        event: "log",
        message: "Diagnostic emitted through the log tool",
      },
    ]);

    expect(entries).toEqual([
      expect.objectContaining({
        kind: "log",
        level: "debug",
        message: "Diagnostic emitted through the log tool",
      }),
    ]);
  });

  it("lets semantic agent/log messages begin with the legacy Tool: prefix", () => {
    const { entries } = buildLogEntries([
      {
        type: "progress",
        level: "debug",
        message: "Tool: this is agent narration",
        data: { event: "assistant_message" },
      },
      {
        type: "progress",
        level: "info",
        event: "log",
        message: "Tool: this is an explicit log",
      },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["agent", "log"]);
  });
});

describe("buildTurnRows — per-turn projection", () => {
  it("parses well-formed turn rows", () => {
    const rows = buildTurnRows([
      turnLog({
        event: "turn",
        index: 1,
        latencyMs: 4200,
        inputTokens: 120,
        outputTokens: 340,
        cacheReadTokens: 96000,
        cacheWriteTokens: 800,
        contextTokens: 96920,
        contextWindow: 200000,
      }),
    ]);
    expect(rows).toEqual([
      {
        index: 1,
        contextTokens: 96920,
        inputTokens: 120,
        outputTokens: 340,
        cacheReadTokens: 96000,
        cacheWriteTokens: 800,
        latencyMs: 4200,
        contextWindow: 200000,
      },
    ]);
  });

  it("keeps the window ABSENT rather than zeroed when the runner states none", () => {
    // The denominator of the whole context reading. "Unknown" and "0" are
    // different statements, and a defaulted 0 would be indistinguishable from a
    // runner that genuinely reported one — so the key must simply not be there.
    const rows = buildTurnRows([
      turnLog({ event: "turn", index: 1, inputTokens: 10, outputTokens: 5 }),
    ]);
    expect(rows[0]!).not.toHaveProperty("contextWindow");
  });

  it("carries the window the runner stated", () => {
    const rows = buildTurnRows([
      turnLog({ event: "turn", index: 1, inputTokens: 10, contextWindow: 1_000_000 }),
    ]);
    expect(rows[0]!.contextWindow).toBe(1_000_000);
  });

  it("drops a malformed window instead of coercing it", () => {
    const rows = buildTurnRows([
      turnLog({ event: "turn", index: 1, inputTokens: 10, contextWindow: "200k" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).not.toHaveProperty("contextWindow");
  });

  it("ignores rows carrying a different `data.event`", () => {
    const rows = buildTurnRows([
      turnLog({ event: "output_reprompt", index: 1 }),
      { type: "progress", level: "debug", message: "plain narration" },
      { type: "result", level: "info", event: "output", data: { foo: 1 } },
      turnLog({ event: "turn", index: 7, inputTokens: 1, outputTokens: 2 }),
    ]);
    expect(rows.map((r) => r.index)).toEqual([7]);
  });

  it("tolerates a missing latencyMs", () => {
    const rows = buildTurnRows([
      turnLog({ event: "turn", index: 3, inputTokens: 10, outputTokens: 5, cacheReadTokens: 20 }),
    ]);
    expect(rows[0]!.latencyMs).toBeUndefined();
    // `contextTokens` reads 0 when absent — it is NOT recomputed from the
    // parts. The emitter (`buildTurnProgress`) sets it unconditionally, so an
    // absent value means a malformed payload, not an older emitter; the
    // recompute that used to sit here plotted a bar nothing had measured
    // (`docs/NO_TRANSITIONAL_CODE.md` §1).
    expect(rows[0]!.contextTokens).toBe(0);
  });

  it("tolerates malformed or absent data without throwing", () => {
    const rows = buildTurnRows([
      { type: "progress", level: "debug", message: "no data at all" },
      { type: "progress", level: "debug", message: "null data", data: null },
      turnLog({ event: "turn" }), // no index → unplottable
      turnLog({ event: "turn", index: "two" }),
      turnLog({ event: "turn", index: 4, inputTokens: "many", latencyMs: "slow" }),
    ]);
    expect(rows).toEqual([
      {
        index: 4,
        contextTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
  });

  it("returns an empty array for runs predating the breadcrumb", () => {
    expect(buildTurnRows([{ type: "progress", level: "debug", message: "hello" }])).toEqual([]);
  });
});

describe("buildLogEntries — turn breadcrumbs excluded from the stream", () => {
  it("drops turn rows so they do not drown the agent's narration", () => {
    // A heavy run emits ~108 of them; interleaved they bury the real log.
    const logs: RawLog[] = [
      { type: "progress", level: "debug", message: "before" },
      turnLog({ event: "turn", index: 1, inputTokens: 1, outputTokens: 2 }),
      { type: "progress", level: "debug", message: "after" },
    ];
    const { entries } = buildLogEntries(logs);
    expect(entries.map(entryLabel)).toEqual(["before", "after"]);
  });

  it("leaves every other row class untouched", () => {
    const logs: RawLog[] = [
      { type: "result", level: "info", event: "output", data: { foo: 1 } },
      { type: "progress", level: "info", message: "MCP connected", data: { boot: true } },
      turnLog({ event: "turn", index: 1, inputTokens: 1, outputTokens: 2 }),
      {
        type: "progress",
        level: "debug",
        message: "Tool: read",
        data: { args: { path: "a.md" }, durationMs: 120 },
      },
      { type: "system", level: "warn", message: "heads up" },
    ];
    const { entries, output } = buildLogEntries(logs);
    expect(output).toEqual({ foo: 1 });
    expect(entries.map(entryLabel)).toEqual(["MCP connected", "Tool: read", "heads up"]);
    expect(toolEntry(entries, 1).detail).toBe("path: a.md");
    expect(toolEntry(entries, 1).durationMs).toBe(120);
    expect(entries[2]!.level).toBe("warn");
  });
});

describe("journalLevel — what the run overview counts and the journal filters", () => {
  const tool = (status: ToolExecutionEntry["status"]): ExecutionEntry => ({
    id: status,
    kind: "tool",
    tool: "gmail__search",
    status,
  });

  it("puts a tool call that did not complete under the errors", () => {
    expect(journalLevel(tool("failed"))).toBe("error");
    expect(journalLevel(tool("interrupted"))).toBe("error");
  });

  it("leaves a completed or running call at its own level", () => {
    expect(journalLevel(tool("success"))).toBe("info");
    expect(journalLevel(tool("running"))).toBe("info");
    expect(journalLevel({ id: "w", kind: "log", level: "warn", message: "slow" })).toBe("warn");
  });
});

describe("buildLogEntries — the integration a call reached", () => {
  const github = { id: "@acme/github", tool: "list.issues", title: "List issues" };
  const start = (data: Record<string, unknown>): RawLog => ({
    type: "progress",
    level: "debug",
    message: "Tool: acme_github__list_issues_1a2b3c4d",
    data: { tool: "acme_github__list_issues_1a2b3c4d", toolCallId: "call-1", ...data },
  });
  const end = (data: Record<string, unknown>): RawLog => ({
    type: "progress",
    level: "debug",
    message: "Tool result: acme_github__list_issues_1a2b3c4d",
    data: {
      tool: "acme_github__list_issues_1a2b3c4d",
      toolCallId: "call-1",
      result: "[]",
      isError: false,
      ...data,
    },
  });

  it("carries the identity from the start when only it has one", () => {
    const { entries } = buildLogEntries([start({ args: {}, integration: github }), end({})]);
    expect(toolEntry(entries).integration).toEqual(github);
  });

  it("carries the identity from the end when only it has one, the start arriving late", () => {
    const { entries } = buildLogEntries([end({ integration: github }), start({ args: {} })]);
    expect(toolEntry(entries)).toMatchObject({ integration: github, args: {} });
  });

  it("keeps the exposed name as the tool, whatever the identity says", () => {
    const { entries } = buildLogEntries([start({ args: {}, integration: github })]);
    expect(toolEntry(entries).tool).toBe("acme_github__list_issues_1a2b3c4d");
  });

  it("records no identity for a call that carries none, nor a malformed one", () => {
    const { entries } = buildLogEntries([
      start({ args: { q: "bug" } }),
      end({ integration: { id: "@acme/github" } }),
    ]);
    expect(toolEntry(entries)).not.toHaveProperty("integration");
    expect(toolEntry(entries).detail).toBe("q: bug");
  });

  it("lists the integrations reached, once each, in order of first call", () => {
    const platform = { id: "@appstrate/platform", tool: "note" };
    const { entries } = buildLogEntries([
      start({ toolCallId: "a", args: {}, integration: github }),
      start({ toolCallId: "b", args: {}, integration: platform }),
      start({ toolCallId: "c", args: {}, integration: github }),
      start({ toolCallId: "d", args: {} }),
    ]);
    expect(journalIntegrationIds(entries)).toEqual(["@acme/github", "@appstrate/platform"]);
  });
});

describe("buildLogEntries — an api_call reads as its request", () => {
  const apiCall = (tool: string, args: Record<string, unknown>, integration = true): RawLog => ({
    type: "progress",
    level: "debug",
    message: "Tool: acme_github__api_call",
    data: {
      tool: "acme_github__api_call",
      toolCallId: "call-1",
      args,
      ...(integration ? { integration: { id: "@acme/github", tool } } : {}),
    },
  });

  it("reads the request's method and target", () => {
    const { entries } = buildLogEntries([
      apiCall("api_call", { method: "GET", target: "https://api.github.com/repos" }),
    ]);
    expect(toolEntry(entries).detail).toBe("GET https://api.github.com/repos");
  });

  it("flattens the arguments of a call missing the method its schema requires", () => {
    const { entries } = buildLogEntries([
      apiCall("api_call", { target: "https://api.github.com/repos" }),
    ]);
    expect(toolEntry(entries).detail).toBe("target: https://api.github.com/repos");
  });

  it("reads the method and a templated target of an auth-scoped api_call", () => {
    const { entries } = buildLogEntries([
      apiCall("api_call__default", { target: "{{base}}/issues", method: "POST", body: "{}" }),
    ]);
    expect(toolEntry(entries).detail).toBe("POST {{base}}/issues");
  });

  it("flattens the arguments of a call without identity", () => {
    const { entries } = buildLogEntries([
      apiCall("api_call", { target: "https://api.github.com/repos" }, false),
    ]);
    expect(toolEntry(entries).detail).toBe("target: https://api.github.com/repos");
  });
});

describe("buildLogEntries — the platform log tool", () => {
  const log = { id: "@appstrate/platform", tool: "log" };
  const logStart: RawLog = {
    type: "progress",
    level: "debug",
    message: "Tool: appstrate_platform__log",
    data: {
      tool: "appstrate_platform__log",
      toolCallId: "call-1",
      args: { level: "info", message: "Trois factures" },
      integration: log,
    },
  };
  const logLine: RawLog = {
    type: "progress",
    level: "info",
    event: "log",
    message: "Trois factures",
  };
  const logEnd = (isError: boolean): RawLog => ({
    type: "progress",
    level: "debug",
    message: "Tool result: appstrate_platform__log",
    data: {
      tool: "appstrate_platform__log",
      toolCallId: "call-1",
      result: "",
      isError,
      integration: log,
    },
  });

  it("shows the journal line alone for a call that completed", () => {
    const { entries } = buildLogEntries([logStart, logLine, logEnd(false)]);
    expect(entries.map((entry) => entry.kind)).toEqual(["log"]);
  });

  it("shows nothing of a call still running, so its row never appears then goes", () => {
    const { entries } = buildLogEntries([logStart]);
    expect(entries).toEqual([]);
  });

  it("keeps the tool row of a call that failed, which wrote no journal line", () => {
    const { entries } = buildLogEntries([logStart, logEnd(true)]);
    expect(toolEntry(entries).status).toBe("failed");
  });

  it("keeps the tool row of a call the run's end interrupted", () => {
    const { entries } = buildLogEntries([logStart], { isRunTerminal: true });
    expect(toolEntry(entries).status).toBe("interrupted");
  });

  it("keeps a call of the same exposed name recorded without identity", () => {
    const { integration: _, ...data } = logStart.data!;
    const { entries } = buildLogEntries([{ ...logStart, data }]);
    expect(toolEntry(entries).tool).toBe("appstrate_platform__log");
  });
});

describe("toolLabel and journalSearchText — the names a tool call goes by", () => {
  const t = (key: string) => `t(${key})`;
  const call = (
    tool: string,
    integration?: ToolExecutionEntry["integration"],
  ): ToolExecutionEntry => ({
    id: "tool:call-1",
    kind: "tool",
    tool,
    status: "success",
    ...(integration ? { integration } : {}),
  });
  const github = call("acme_github__list_issues_1a2b3c4d", {
    id: "@acme/github",
    tool: "list.issues",
    title: "List issues",
  });

  it("names a call by its server's title, else by the tool's name on its server", () => {
    expect(toolLabel(github, t)).toBe("List issues");
    expect(toolLabel(call("acme_github__get_me", { id: "@acme/github", tool: "get_me" }), t)).toBe(
      "get_me",
    );
  });

  it("names the runner's own tools by their label", () => {
    expect(toolLabel(call("output"), t)).toBe("t(log.harness.output)");
    expect(toolLabel(call("publish_file"), t)).toBe("t(log.harness.publish_file)");
    expect(toolLabel(call("bash"), t)).toBe("t(log.harness.bash)");
  });

  it("keeps the name the model called for a call without identity", () => {
    expect(toolLabel(call("pierre_cabriere_gith__api_call"), t)).toBe(
      "pierre_cabriere_gith__api_call",
    );
  });

  it("finds a call by its exposed name, its label, its integration's id and name", () => {
    const text = journalSearchText(github, t, (id) => (id === "@acme/github" ? "GitHub" : id));
    for (const term of [
      "acme_github__list_issues_1a2b3c4d",
      "List issues",
      "list.issues",
      "@acme/github",
      "GitHub",
    ]) {
      expect(text).toContain(term);
    }
  });
});

describe("filterJournal — what the journal shows", () => {
  const t = (key: string) => key;
  const integrations = (id: string) => ({
    name: id === "@acme/github" ? "GitHub" : id,
    pending: false,
  });
  const tool = (id: string, integrationId?: string, level?: string): ToolExecutionEntry => ({
    id,
    kind: "tool",
    tool: `${id}_exposed`,
    status: "success",
    ...(level ? { level } : {}),
    ...(integrationId ? { integration: { id: integrationId, tool: id } } : {}),
  });
  const entries: ExecutionEntry[] = [
    { id: "m", kind: "agent", level: "debug", message: "Je lis les tickets." },
    tool("list_issues", "@acme/github"),
    tool("get_me", "@acme/github"),
    tool("note", "@appstrate/platform"),
    tool("output"),
    { id: "j", kind: "log", level: "info", message: "Trois tickets trouvés" },
  ];
  const none: JournalFilters = {
    levels: [],
    types: [],
    integrations: [],
    showTools: true,
    query: "",
    locale: "fr",
  };
  const ids = (filters: Partial<JournalFilters>) =>
    filterJournal(entries, { ...none, ...filters }, t, integrations).map((entry) => entry.id);

  it("keeps every entry when nothing filters", () => {
    expect(ids({})).toEqual(["m", "list_issues", "get_me", "note", "output", "j"]);
  });

  it("keeps only the tool calls of the chosen integration", () => {
    expect(ids({ integrations: ["@acme/github"] })).toEqual(["list_issues", "get_me"]);
    expect(ids({ integrations: ["@acme/github", "@appstrate/platform"] })).toEqual([
      "list_issues",
      "get_me",
      "note",
    ]);
  });

  it("combines the integration filter with the type and the search", () => {
    expect(ids({ integrations: ["@acme/github"], types: ["journal"] })).toEqual([]);
    expect(ids({ integrations: ["@acme/github"], types: ["tool"] })).toEqual([
      "list_issues",
      "get_me",
    ]);
    expect(ids({ integrations: ["@acme/github"], query: "get_me" })).toEqual(["get_me"]);
  });

  it("finds a call by its integration's display name", () => {
    expect(ids({ query: "github" })).toEqual(["list_issues", "get_me"]);
  });

  it("hides every tool call when tools are hidden", () => {
    expect(ids({ showTools: false })).toEqual(["m", "j"]);
  });

  it("keeps the entries of the chosen levels", () => {
    expect(ids({ levels: ["info"], types: ["journal"] })).toEqual(["j"]);
  });
});

describe("journalRows — runner lines fold into one row", () => {
  const system = (id: string, level = "info"): ExecutionEntry => ({
    id,
    kind: "runtime",
    level,
    message: id,
    sourceType: "progress",
  });
  const say = (id: string): ExecutionEntry => ({ id, kind: "agent", level: "debug", message: id });
  const none = { levels: [], types: [], query: "" };
  const shape = (rows: JournalRow[]) =>
    rows.map((row) =>
      row.kind === "group" ? `${row.id}[${row.entries.map((e) => e.id).join(",")}]` : row.id,
    );

  it("folds runs of two or more at the start, in the middle and at the end", () => {
    const entries = [
      system("a"),
      system("b", "debug"),
      say("m1"),
      system("c"),
      system("d"),
      system("e"),
      say("m2"),
      system("f"),
      system("g"),
    ];
    expect(shape(journalRows(entries, none))).toEqual([
      "group:a[a,b]",
      "m1",
      "group:c[c,d,e]",
      "m2",
      "group:f[f,g]",
    ]);
  });

  it("leaves a single runner line as a row of its own", () => {
    expect(shape(journalRows([say("m1"), system("a"), say("m2")], none))).toEqual([
      "m1",
      "a",
      "m2",
    ]);
  });

  it("never folds a warning or an error, which ends the run", () => {
    const entries = [
      system("a"),
      system("w", "warn"),
      system("b"),
      system("c"),
      system("x", "error"),
      system("d"),
    ];
    expect(shape(journalRows(entries, none))).toEqual(["a", "w", "group:b[b,c]", "x", "d"]);
  });

  it("folds nothing but the runner's lines", () => {
    const line: ExecutionEntry = { id: "j", kind: "log", level: "info", message: "j" };
    expect(shape(journalRows([say("m1"), say("m2"), line, { ...line, id: "k" }], none))).toEqual([
      "m1",
      "m2",
      "j",
      "k",
    ]);
  });

  it("keeps a group's id as its run grows", () => {
    const first = journalRows([system("a"), system("b")], none);
    const grown = journalRows([system("a"), system("b"), system("c")], none);
    expect(first[0]?.id).toBe(grown[0]!.id);
  });

  it("folds nothing while a search or a level or type filter is in force", () => {
    const entries = [system("a"), system("b")];
    for (const filters of [
      { ...none, query: "a" },
      { ...none, levels: ["info"] },
      { ...none, types: ["system"] },
    ]) {
      expect(shape(journalRows(entries, filters))).toEqual(["a", "b"]);
    }
  });

  it("measures a group from its first line to its last, 0 when undated", () => {
    const dated = (id: string, at: string) => ({ ...system(id), createdAt: at });
    const [group] = journalRows(
      [dated("a", "2026-07-01T10:00:00.000Z"), dated("b", "2026-07-01T10:00:02.500Z")],
      none,
    );
    const [undated] = journalRows([system("a"), system("b")], none);
    if (group?.kind !== "group" || undated?.kind !== "group") throw new Error("not grouped");
    expect(journalGroupElapsedMs(group)).toBe(2500);
    expect(journalGroupElapsedMs(undated)).toBe(0);
  });
});

describe("expandedJournalGroups — a group is open while its lines arrive", () => {
  const system = (id: string): ExecutionEntry => ({
    id,
    kind: "runtime",
    level: "info",
    message: id,
    sourceType: "progress",
  });
  const say = (id: string): ExecutionEntry => ({ id, kind: "agent", level: "debug", message: id });
  const none = { levels: [], types: [], query: "" };
  const boot = [system("a"), system("b")];
  const later = [...boot, say("m"), system("c"), system("d")];
  const open = (entries: ExecutionEntry[], state: Parameters<typeof expandedJournalGroups>[1]) => [
    ...expandedJournalGroups(journalRows(entries, none), state),
  ];

  it("opens a live run's last group, then folds it once another event follows", () => {
    expect(open(boot, { open: {}, live: true })).toEqual(["group:a"]);
    expect(open([...boot, say("m")], { open: {}, live: true })).toEqual([]);
  });

  it("does the same for a group later in the run, and folds every group when the run ends", () => {
    expect(open(later, { open: {}, live: true })).toEqual(["group:c"]);
    expect(open(later, { open: {}, live: false })).toEqual([]);
  });

  it("keeps a group as the reader set it", () => {
    expect(open(later, { open: { "group:a": true, "group:c": false }, live: true })).toEqual([
      "group:a",
    ]);
  });

  it("keeps the group holding the open row open", () => {
    expect(open(later, { open: {}, live: false, selectedEntryId: "b" })).toEqual(["group:a"]);
  });
});
