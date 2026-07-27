// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the missing-`output` re-prompt (`maybeRepromptForOutput`).
 *
 * Production shape being defended: an agent that declares an output schema
 * researches correctly, then ends its loop WITHOUT calling `output`. The
 * platform only notices at finalize time — container gone, context destroyed,
 * run fully paid for. The runner gives the still-alive session exactly one
 * corrective turn; the platform-side validation stays as the safety net.
 */

import { describe, it, expect } from "bun:test";
import { installSessionBridge, maybeRepromptForOutput } from "../src/pi-runner.ts";
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

const RUN_ID = "run_reprompt_test";
const STUB_BUNDLE = makeTestBundle(makeBundlePackage("@test/stub", "0.0.0", "agent", {}));

/** Simulate one settled assistant turn: append the message, then fire message_end. */
function endTurn(session: FakeSession, msg: unknown): void {
  session.pushMessage(msg);
  session.emit({ type: "message_end" });
}

/** Successful `output` tool call — the terminal-tool early stop. */
function callOutput(session: FakeSession): void {
  session.emit({ type: "tool_execution_end", toolName: "output", result: "ok" });
}

function repromptEvents(events: RunEvent[]): RunEvent[] {
  return events.filter(
    (e) => (e.data as { event?: string } | undefined)?.event === "output_reprompt",
  );
}

describe("maybeRepromptForOutput — guards", () => {
  it("does NOT re-prompt when the agent already called output", async () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID, { terminalTools: ["output"] });

    callOutput(session);
    endTurn(session, { role: "assistant", stopReason: "stop", content: [] });

    const reprompted = await maybeRepromptForOutput({
      session,
      bridge,
      terminalTools: ["output"],
      sink,
      runId: RUN_ID,
    });

    expect(reprompted).toBe(false);
    expect(session.prompts).toHaveLength(0);
    expect(repromptEvents(sink.events)).toHaveLength(0);
  });

  it("does NOT re-prompt when `output` is not a terminal tool (agent declares no output schema)", async () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID);

    endTurn(session, { role: "assistant", stopReason: "stop", content: [] });

    const reprompted = await maybeRepromptForOutput({
      session,
      bridge,
      terminalTools: [],
      sink,
      runId: RUN_ID,
    });

    expect(reprompted).toBe(false);
    expect(session.prompts).toHaveLength(0);
  });

  it("re-prompts exactly once, with a warn-level `output_reprompt` breadcrumb, on a clean finish without output", async () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID, { terminalTools: ["output"] });

    endTurn(session, {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Sélection de 7 informations marquantes effectuée" }],
    });

    const reprompted = await maybeRepromptForOutput({
      session,
      bridge,
      terminalTools: ["output"],
      sink,
      runId: RUN_ID,
      now: () => 1234,
    });

    expect(reprompted).toBe(true);
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain("`output`");

    const breadcrumbs = repromptEvents(sink.events);
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]).toMatchObject({
      type: "appstrate.progress",
      runId: RUN_ID,
      level: "warn",
      timestamp: 1234,
      data: { event: "output_reprompt" },
    });
  });

  it("does NOT re-prompt a cancelled run (abort signal already fired)", async () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID, { terminalTools: ["output"] });

    endTurn(session, { role: "assistant", stopReason: "stop", content: [] });

    const controller = new AbortController();
    controller.abort(new Error("Run cancelled"));

    const reprompted = await maybeRepromptForOutput({
      session,
      bridge,
      terminalTools: ["output"],
      sink,
      runId: RUN_ID,
      signal: controller.signal,
    });

    expect(reprompted).toBe(false);
    expect(session.prompts).toHaveLength(0);
    expect(repromptEvents(sink.events)).toHaveLength(0);
  });

  it("does NOT re-prompt a session whose last turn ended aborted (no terminal tool completed)", async () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID, { terminalTools: ["output"] });

    endTurn(session, {
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "Request was aborted",
      content: [],
    });

    const reprompted = await maybeRepromptForOutput({
      session,
      bridge,
      terminalTools: ["output"],
      sink,
      runId: RUN_ID,
    });

    expect(reprompted).toBe(false);
    expect(session.prompts).toHaveLength(0);
  });

  it("does NOT re-prompt a session whose last turn ended in a provider error", async () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID, { terminalTools: ["output"] });

    endTurn(session, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider exploded",
      content: [],
    });

    const reprompted = await maybeRepromptForOutput({
      session,
      bridge,
      terminalTools: ["output"],
      sink,
      runId: RUN_ID,
    });

    expect(reprompted).toBe(false);
    expect(session.prompts).toHaveLength(0);
  });

  it("propagates a cancellation raised DURING the corrective turn", async () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID, { terminalTools: ["output"] });

    endTurn(session, { role: "assistant", stopReason: "stop", content: [] });

    // The runner races the corrective prompt against the run's abort signal,
    // exactly like the first prompt — a cancel mid-retry must still bubble.
    const rejection = Promise.reject(new Error("Run cancelled"));
    rejection.catch(() => {});

    await expect(
      maybeRepromptForOutput({
        session,
        bridge,
        terminalTools: ["output"],
        sink,
        runId: RUN_ID,
        race: (promise) => Promise.race([promise, rejection]) as typeof promise,
      }),
    ).rejects.toThrow("Run cancelled");
  });
});

describe("PiRunner.run — missing-output re-prompt end to end", () => {
  it("issues one corrective turn and finalizes the run when the retry delivers output", async () => {
    const sink = createCaptureSink();
    const runner = new ScriptedPiRunner(
      async (session) => {
        // The corrective turn: the agent finally calls `output`, which trips
        // the bridge's early stop — surfacing as a trailing "aborted" turn.
        session.onPrompt = () => {
          callOutput(session);
          endTurn(session, {
            role: "assistant",
            stopReason: "aborted",
            errorMessage: "Request was aborted",
            content: [],
          });
        };
        // The original loop: research done, no `output` call.
        session.emit({ type: "tool_execution_end", toolName: "web_search", result: "7 items" });
        endTurn(session, {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Sélection de 7 informations marquantes effectuée" }],
        });
      },
      { terminalTools: ["output"] },
    );

    await runner.run({ bundle: STUB_BUNDLE, context: makeContext(), eventSink: sink });

    expect(repromptEvents(sink.events)).toHaveLength(1);
    // The trailing `stopReason: "aborted"` is the runner's own early stop, not
    // a failure — the run must finalize as a success.
    expect(sink.finalized?.status).toBe("success");
    expect(sink.finalized?.error).toBeUndefined();
    expect(sink.events.find((e) => e.type === "appstrate.error")).toBeUndefined();
  });

  it("re-prompts once and leaves the missing-output verdict to the platform when the retry also fails", async () => {
    const sink = createCaptureSink();
    let promptCalls = 0;
    const runner = new ScriptedPiRunner(
      async (session) => {
        session.onPrompt = () => {
          promptCalls += 1;
          // Still no `output` — the model drifted twice.
          endTurn(session, { role: "assistant", stopReason: "stop", content: [] });
        };
        endTurn(session, { role: "assistant", stopReason: "stop", content: [] });
      },
      { terminalTools: ["output"] },
    );

    await runner.run({ bundle: STUB_BUNDLE, context: makeContext(), eventSink: sink });

    // Exactly one attempt — never a loop.
    expect(promptCalls).toBe(1);
    expect(repromptEvents(sink.events)).toHaveLength(1);
    // The runner still reports success (no terminal error); the platform's
    // finalize-time output-schema validation is the safety net that fails it.
    expect(sink.finalized?.status).toBe("success");
    expect(sink.finalized?.output).toBeNull();
  });

  it("does not re-prompt when the agent called output during the normal loop", async () => {
    const sink = createCaptureSink();
    const runner = new ScriptedPiRunner(
      async (session) => {
        session.onPrompt = () => {
          throw new Error("must not re-prompt");
        };
        callOutput(session);
        endTurn(session, {
          role: "assistant",
          stopReason: "aborted",
          errorMessage: "Request was aborted",
          content: [],
        });
      },
      { terminalTools: ["output"] },
    );

    await runner.run({ bundle: STUB_BUNDLE, context: makeContext(), eventSink: sink });

    expect(repromptEvents(sink.events)).toHaveLength(0);
    expect(sink.finalized?.status).toBe("success");
  });
});
