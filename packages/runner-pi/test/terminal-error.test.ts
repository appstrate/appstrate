// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for {@link readTerminalError} — the runner's authoritative
 * success/failure verdict read from a settled Pi SDK session.
 *
 * The verdict is the LAST message's outcome, NOT the presence of any
 * errored turn earlier in the loop. A transient error the agent recovered
 * from leaves a clean final message → undefined (success); a loop that
 * ended on an errored final turn → a RunError (failed). This is what lets
 * the platform stop reconstructing status from the `run_logs` adapter-error
 * trail (regression: run_fd977eb6).
 */

import { describe, it, expect } from "bun:test";
import { readTerminalError } from "../src/pi-runner.ts";
import { createFakeSession } from "./helpers.ts";

describe("readTerminalError", () => {
  it("returns undefined for an empty session", () => {
    const session = createFakeSession();
    expect(readTerminalError(session)).toBeUndefined();
  });

  it("returns undefined when the final assistant turn stopped cleanly", () => {
    const session = createFakeSession();
    session.pushMessage({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
    });
    expect(readTerminalError(session)).toBeUndefined();
  });

  it("returns a RunError when the final assistant turn ended in error", () => {
    const session = createFakeSession();
    session.pushMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex error: server_error",
      content: [],
    });
    const err = readTerminalError(session);
    expect(err?.code).toBe("adapter_error");
    expect(err?.message).toBe("Codex error: server_error");
  });

  it("returns undefined when a transient error was recovered (later clean turn)", () => {
    // The crux of run_fd977eb6: an errored turn mid-loop, then the agent
    // recovered and the FINAL turn stopped cleanly → success.
    const session = createFakeSession();
    session.pushMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex error: server_error",
      content: [],
    });
    session.pushMessage({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "recovered and finished" }],
    });
    expect(readTerminalError(session)).toBeUndefined();
  });

  it("returns failed when the final turn errored even after earlier success", () => {
    const session = createFakeSession();
    session.pushMessage({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "partial work" }],
    });
    session.pushMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex error: server_error (final turn)",
      content: [],
    });
    const err = readTerminalError(session);
    expect(err?.message).toMatch(/final turn/);
  });

  it("falls back to a generic message when stopReason=error carries no errorMessage", () => {
    const session = createFakeSession();
    session.pushMessage({ role: "assistant", stopReason: "error", content: [] });
    const err = readTerminalError(session);
    expect(err?.message).toMatch(/ended in an error/);
  });

  it("ignores a trailing non-assistant message", () => {
    // If the final state entry is a tool/user message, there is no
    // assistant-turn error to read → undefined.
    const session = createFakeSession();
    session.pushMessage({ role: "assistant", stopReason: "error", errorMessage: "boom" });
    session.pushMessage({ role: "tool", content: [{ type: "text", text: "tool result" }] });
    expect(readTerminalError(session)).toBeUndefined();
  });
});
