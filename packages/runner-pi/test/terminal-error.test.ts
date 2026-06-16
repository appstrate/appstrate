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
import { createFakeSession, createInternalCapture } from "./helpers.ts";

const RUN_ID = "run_terminal_test";

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
