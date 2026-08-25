// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the bridge's terminal verdict — `getTerminalError()`.
 *
 * The verdict is the LAST *assistant* turn's outcome, captured from the
 * `message_end` event stream (NOT read from `session.state.messages` after
 * the fact). This makes it robust to trailing non-assistant messages —
 * toolResults, and especially compaction summaries appended after an
 * overflow error (#464) — which would otherwise mask the real terminal
 * turn. A transient error the agent recovered from (a later clean
 * assistant turn) yields undefined → success. Regression: run_fd977eb6.
 */

import { describe, it, expect } from "bun:test";
import { installSessionBridge } from "../src/pi-runner.ts";
import {
  createCaptureSink,
  createFakeSession,
  createInternalCapture,
  makeBundlePackage,
  makeContext,
  makeTestBundle,
  ScriptedPiRunner,
  type FakeSession,
} from "./helpers.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";

const RUN_ID = "run_terminal_test";

const STUB_BUNDLE = makeTestBundle(makeBundlePackage("@test/stub", "0.0.0", "agent", {}));

/** Simulate one settled turn: append the message, then fire message_end. */
function endTurn(session: ReturnType<typeof createFakeSession>, msg: unknown): void {
  session.pushMessage(msg);
  session.emit({ type: "message_end" });
}

describe("SessionBridgeHandle.getTerminalError", () => {
  it("returns undefined for a session with no turns", () => {
    const handle = installSessionBridge(createFakeSession(), createInternalCapture(), RUN_ID);
    expect(handle.getTerminalError()).toBeUndefined();
  });

  it("returns undefined when the final assistant turn stopped cleanly", () => {
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
    });
    expect(handle.getTerminalError()).toBeUndefined();
  });

  it("returns a RunError when the final assistant turn ended in error", () => {
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex error: server_error",
      content: [],
    });
    const err = handle.getTerminalError();
    expect(err?.code).toBe("adapter_error");
    expect(err?.message).toBe("Codex error: server_error");
    // The classification rides alongside the raw text, never instead of it:
    // the run surface keeps the debug sentence AND now says what class of
    // failure it was, using the same rules the chat surface classifies with.
    // "Codex error: server_error" names no status and no actionable cause, so
    // the class is `unknown` — which stays retryable: a fresh attempt is the
    // only way to learn anything more about it.
    expect(err?.context).toEqual({ error_category: "unknown", error_retryable: true });
  });

  it("classifies a dead credential as terminal, not as a transient outage", () => {
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "401 Incorrect API key provided: sk-***",
      content: [],
    });
    const err = handle.getTerminalError();
    expect(err?.message).toBe("401 Incorrect API key provided: sk-***");
    expect(err?.context).toEqual({
      error_category: "credential_unavailable",
      error_retryable: false,
    });
  });

  it("returns a RunError on stopReason 'aborted' (provider abort, not user cancel)", () => {
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, {
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "Request was aborted",
      content: [],
    });
    expect(handle.getTerminalError()?.message).toBe("Request was aborted");
  });

  it("returns undefined when a transient error was recovered (later clean turn)", () => {
    // The crux of run_fd977eb6: an errored turn mid-loop, then the agent
    // recovered and the FINAL assistant turn stopped cleanly → success.
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "transient 5xx",
      content: [],
    });
    endTurn(session, {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "recovered" }],
    });
    expect(handle.getTerminalError()).toBeUndefined();
  });

  it("returns failed when the final assistant turn errored after earlier success", () => {
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "partial" }],
    });
    endTurn(session, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "final-turn failure",
      content: [],
    });
    expect(handle.getTerminalError()?.message).toMatch(/final-turn failure/);
  });

  it("is NOT masked by a trailing non-assistant message (toolResult / compaction summary)", () => {
    // The reason verdict is tracked from the stream, not read from
    // state.messages.at(-1): after an overflow-errored assistant turn, the
    // SDK appends a compactionSummary (#464). That trailing entry must not
    // flip the run back to success.
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "prompt is too long (overflow)",
      content: [],
    });
    // SDK appends a compaction summary after the errored turn.
    endTurn(session, { role: "compactionSummary", content: [{ type: "text", text: "summary" }] });
    const err = handle.getTerminalError();
    expect(err?.message).toMatch(/overflow/);
  });

  it("falls back to a generic message when stopReason=error carries no errorMessage", () => {
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, { role: "assistant", stopReason: "error", content: [] });
    expect(handle.getTerminalError()?.message).toMatch(/ended in an error/);
  });
});

/**
 * The sticky sibling of the terminal verdict. `getTerminalError()` answers
 * "how did the FINAL turn end" and deliberately forgets a failure the agent
 * recovered from; `getLastUpstreamError()` answers "did anything upstream ever
 * fail, and what did it say" and deliberately does not. The second question is
 * the only one a run cut off by the wall-clock watchdog can still answer.
 */
describe("SessionBridgeHandle.getLastUpstreamError", () => {
  it("returns undefined for a session with no turns", () => {
    const handle = installSessionBridge(createFakeSession(), createInternalCapture(), RUN_ID);
    expect(handle.getLastUpstreamError()).toBeUndefined();
  });

  it("returns undefined when every turn stopped cleanly", () => {
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
    });
    expect(handle.getLastUpstreamError()).toBeUndefined();
  });

  it("records the stop reason and message of an errored turn", () => {
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "503 Service Unavailable",
      content: [],
    });
    expect(handle.getLastUpstreamError()).toEqual({
      stopReason: "error",
      message: "503 Service Unavailable",
    });
  });

  it("SURVIVES a later clean turn (the case getTerminalError cannot serve)", () => {
    // The whole reason the state exists: `lastAssistantStopReason` is
    // overwritten every turn, so the clean turn below erases the cause there.
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "upstream 503",
      content: [],
    });
    endTurn(session, {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "recovered" }],
    });
    expect(handle.getTerminalError()).toBeUndefined();
    expect(handle.getLastUpstreamError()?.message).toBe("upstream 503");
  });

  it("keeps the MOST RECENT failure when several turns errored", () => {
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "first",
      content: [],
    });
    endTurn(session, {
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "second",
      content: [],
    });
    expect(handle.getLastUpstreamError()).toEqual({ stopReason: "aborted", message: "second" });
  });

  it("falls back to the generic message when the errored turn carried none", () => {
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID);
    endTurn(session, { role: "assistant", stopReason: "error", content: [] });
    expect(handle.getLastUpstreamError()?.message).toMatch(/ended in an error/);
  });
});

/**
 * Drive a scripted run whose session errors on the turns described by
 * `turns`, then hangs until the runner's wall-clock watchdog aborts it —
 * i.e. the exact production shape this feature exists for: a run whose budget
 * is consumed upstream and which is cut off before it can settle a verdict.
 */
async function runUntilWatchdog(
  turns: Array<Record<string, unknown>>,
): Promise<ReturnType<typeof createCaptureSink>> {
  const sink = createCaptureSink();
  // `0.05`s → a 50ms watchdog (the field is seconds; the runner × 1000).
  const runner = new ScriptedPiRunner(async (session: FakeSession, _ctx, signal) => {
    for (const turn of turns) endTurn(session, turn);
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    throw signal?.reason ?? new Error("aborted");
  });
  await runner.run({
    bundle: STUB_BUNDLE,
    context: makeContext({ timeoutSeconds: 0.05 }),
    eventSink: sink,
  });
  return sink;
}

/** The LAST `appstrate.error` — the bridge emits its own for each failed turn. */
function lastErrorEvent(events: RunEvent[]): (RunEvent & { data?: unknown }) | undefined {
  return events.filter((e) => e.type === "appstrate.error").at(-1);
}

describe("PiRunner.run — timeout watchdog carries the upstream cause", () => {
  it("attaches the provider failure as error.context.upstream", async () => {
    const sink = await runUntilWatchdog([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "503 Service Unavailable from provider",
        content: [],
      },
    ]);

    expect(sink.finalized?.status).toBe("timeout");
    // The stable branch key sinks/webhooks match on must NOT have moved.
    expect(sink.finalized?.error?.code).toBe("timeout");
    expect(sink.finalized?.error?.message).toMatch(/timed out after/i);
    expect(sink.finalized?.error?.context).toEqual({
      upstream: { stop_reason: "error", message: "503 Service Unavailable from provider" },
    });
    // …and it reaches the platform: the finalize body's RunError is persisted
    // by `message` alone, so the live `appstrate.error` event is the path that
    // lands the structured cause in `run_logs.data`.
    expect(lastErrorEvent(sink.events)?.data).toEqual({
      upstream: { stop_reason: "error", message: "503 Service Unavailable from provider" },
    });
  });

  it("NEGATIVE CONTROL: no upstream error ever → no `context` key at all", async () => {
    const sink = await runUntilWatchdog([
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "working" }] },
    ]);

    expect(sink.finalized?.error?.code).toBe("timeout");
    // An empty `{}` would read as "we looked upstream and it was fine", which
    // is not what "we never saw a failed turn" means — the key must be absent.
    expect(Object.keys(sink.finalized!.error!)).not.toContain("context");
    expect(lastErrorEvent(sink.events)?.data).toBeUndefined();
  });

  it("still reports the cause when a CLEAN turn followed the errored one", async () => {
    // `lastAssistantStopReason` is blanked by the clean turn; the sticky
    // upstream state is what keeps the 503 attached to the timeout.
    const sink = await runUntilWatchdog([
      { role: "assistant", stopReason: "error", errorMessage: "upstream 503", content: [] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "retrying" }] },
    ]);

    expect(sink.finalized?.error?.code).toBe("timeout");
    expect(sink.finalized?.error?.context).toEqual({
      upstream: { stop_reason: "error", message: "upstream 503" },
    });
  });

  it("bounds the provider message — a huge blob never reaches a log row whole", async () => {
    const sink = await runUntilWatchdog([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "x".repeat(5000),
        content: [],
      },
    ]);

    const upstream = (sink.finalized?.error?.context as { upstream: { message: string } }).upstream;
    expect(upstream.message).toHaveLength(2000);
  });
});

describe("PiRunner.run — timeout watchdog names the cause for a HUMAN", () => {
  // `context` is durable but nothing on screen projects an unknown `data` key,
  // so the cause has to reach `RunError.message` too — the only field that
  // lands in both the `runs.error` column and the log-viewer row.
  it("appends the provider cause after the untouched timeout sentence", async () => {
    const sink = await runUntilWatchdog([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "503 Service Unavailable",
        content: [],
      },
    ]);

    expect(sink.finalized?.error?.message).toBe(
      "Run timed out after 0.05s — the model provider returned an error during the run: 503 Service Unavailable",
    );
    // The structured channel is untouched by the human-channel work.
    expect(sink.finalized?.error?.context).toEqual({
      upstream: { stop_reason: "error", message: "503 Service Unavailable" },
    });
  });

  it("REGRESSION GUARD: no cause ⇒ the message is byte-identical to before", async () => {
    const sink = await runUntilWatchdog([
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "working" }] },
    ]);

    expect(sink.finalized?.error?.message).toBe("Run timed out after 0.05s");
  });

  it("collapses a multi-line provider body to ONE bounded line", async () => {
    // The log viewer renders a row's message with `whitespace-pre-wrap`, so an
    // embedded newline would turn one row into many. Indentation is collapsed
    // too, which is what makes the tight cap enough to carry the meaning.
    const body =
      '{\n  "error": {\n    "type": "overloaded_error",\n    "message": "Overloaded"\n  }\n}';
    const sink = await runUntilWatchdog([
      { role: "assistant", stopReason: "error", errorMessage: body, content: [] },
    ]);

    const message = sink.finalized!.error!.message;
    expect(message).not.toContain("\n");
    expect(message).toBe(
      'Run timed out after 0.05s — the model provider returned an error during the run: { "error": { "type": "overloaded_error", "message": "Overloaded" } }',
    );
    // The archival copy keeps the body verbatim, newlines and all.
    const upstream = (sink.finalized?.error?.context as { upstream: { message: string } }).upstream;
    expect(upstream.message).toBe(body);
  });

  it("bounds the human copy far tighter than the archival copy", async () => {
    const sink = await runUntilWatchdog([
      { role: "assistant", stopReason: "error", errorMessage: "y".repeat(5000), content: [] },
    ]);

    // Human channel: 200 chars — a tenth of the archival budget. Asserted on
    // the provider run itself rather than the whole string, so the prose of
    // the lead-in can be reworded without a magic number to re-derive.
    const message = sink.finalized!.error!.message;
    expect(message.startsWith("Run timed out after 0.05s — ")).toBe(true);
    expect(message.match(/y+/)?.[0]).toHaveLength(200);
    expect(message.endsWith("y".repeat(200))).toBe(true);
    // Archival channel: still the full 2000.
    const upstream = (sink.finalized?.error?.context as { upstream: { message: string } }).upstream;
    expect(upstream.message).toHaveLength(2000);
  });
});

describe("SessionBridgeHandle.getLastUpstreamError — benign aborts", () => {
  /** Complete a terminal tool, which flips the bridge's early-stop flag. */
  function completeTerminalTool(session: FakeSession): void {
    session.emit({ type: "tool_execution_end", toolName: "output", toolCallId: "c1" });
  }

  it("does NOT latch the runner's own early-stop abort", () => {
    // After a successful `output` the runner aborts the SDK loop itself. That
    // trailing `aborted` turn is a success artefact — reporting it as an
    // upstream failure would blame a provider that never failed.
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID, {
      terminalTools: ["output"],
    });
    completeTerminalTool(session);
    endTurn(session, {
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "The operation was aborted",
      content: [],
    });
    expect(handle.getTerminalError()).toBeUndefined();
    expect(handle.getLastUpstreamError()).toBeUndefined();
  });

  it("a benign abort does not ERASE a real failure latched earlier", () => {
    // Why the suppression is applied at latch time, not read time: the 503 is
    // the cause a watchdog firing later must still be able to report.
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID, {
      terminalTools: ["output"],
    });
    endTurn(session, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "upstream 503",
      content: [],
    });
    completeTerminalTool(session);
    endTurn(session, { role: "assistant", stopReason: "aborted", content: [] });
    expect(handle.getLastUpstreamError()?.message).toBe("upstream 503");
  });

  it("STILL latches a provider-side abort when no terminal tool ran", () => {
    // The guard is gated on `terminalToolCompleted` — an abort with no
    // terminal tool behind it is a genuine upstream failure, not our own stop.
    const session = createFakeSession();
    const handle = installSessionBridge(session, createInternalCapture(), RUN_ID, {
      terminalTools: ["output"],
    });
    endTurn(session, {
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "Request was aborted",
      content: [],
    });
    expect(handle.getLastUpstreamError()).toEqual({
      stopReason: "aborted",
      message: "Request was aborted",
    });
  });
});
