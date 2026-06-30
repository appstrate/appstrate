// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { finalizeThrownFailure } from "../../src/runner/finalize-thrown-failure.ts";
import type { RunEvent } from "../../src/types/index.ts";
import type { RunResult, TokenUsage } from "../../src/types/run-result.ts";

const USAGE: TokenUsage = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** A capturing test harness mirroring a runner's emit/drain/sink wiring. */
function harness() {
  const emitted: RunEvent[] = [];
  let finalized: RunResult | undefined;
  let drainCount = 0;
  return {
    emitted,
    get finalized() {
      return finalized;
    },
    get drainCount() {
      return drainCount;
    },
    emit: async (event: RunEvent) => {
      emitted.push(event);
    },
    drainAndEmit: async () => {
      drainCount += 1;
    },
    eventSink: {
      finalize: async (result: RunResult) => {
        finalized = result;
      },
    },
  };
}

describe("finalizeThrownFailure", () => {
  it("rethrows and does NOT finalize when the run was aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const err = new Error("boom");

    await expect(
      finalizeThrownFailure({
        events: [],
        err,
        signal: controller.signal,
        runId: "run_1",
        now: () => 1000,
        emit: h.emit,
        drainAndEmit: h.drainAndEmit,
        eventSink: h.eventSink,
        usage: USAGE,
      }),
    ).rejects.toBe(err);

    expect(h.emitted).toHaveLength(0);
    expect(h.drainCount).toBe(0);
    expect(h.finalized).toBeUndefined();
  });

  it("emits appstrate.error, drains, then finalizes a failed result", async () => {
    const h = harness();
    await finalizeThrownFailure({
      events: [],
      err: new Error("kaboom"),
      signal: undefined,
      runId: "run_2",
      now: () => 4242,
      emit: h.emit,
      drainAndEmit: h.drainAndEmit,
      eventSink: h.eventSink,
      usage: USAGE,
    });

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({
      type: "appstrate.error",
      timestamp: 4242,
      runId: "run_2",
      message: "kaboom",
    });
    expect(h.drainCount).toBe(1);

    expect(h.finalized?.status).toBe("failed");
    expect(h.finalized?.error).toEqual({ message: "kaboom", stack: expect.any(String) });
    expect(h.finalized?.usage).toEqual(USAGE);
  });

  it("emits and finalizes before vs after drain in the documented order", async () => {
    const order: string[] = [];
    const err = new Error("x");
    await finalizeThrownFailure({
      events: [],
      err,
      signal: undefined,
      runId: "run_order",
      now: () => 1,
      emit: async () => {
        order.push("emit");
      },
      drainAndEmit: async () => {
        order.push("drain");
      },
      eventSink: {
        finalize: async () => {
          order.push("finalize");
        },
      },
      usage: USAGE,
    });
    expect(order).toEqual(["emit", "drain", "finalize"]);
  });

  it("does not let a throwing drain mask the failure (best-effort)", async () => {
    const h = harness();
    await finalizeThrownFailure({
      events: [],
      err: new Error("nope"),
      signal: undefined,
      runId: "run_3",
      now: () => 1,
      emit: h.emit,
      drainAndEmit: async () => {
        throw new Error("drain blew up");
      },
      eventSink: h.eventSink,
      usage: USAGE,
    });
    // Drain threw, but the failure still finalized.
    expect(h.finalized?.status).toBe("failed");
  });

  it("applies the transform to BOTH the emitted error event and the terminal result", async () => {
    const h = harness();
    const SECRET = "sk-super-secret-token";
    const redact = <T>(value: T): T =>
      JSON.parse(JSON.stringify(value).split(SECRET).join("[REDACTED]")) as T;

    await finalizeThrownFailure({
      events: [],
      err: new Error(`failed using ${SECRET} upstream`),
      signal: undefined,
      runId: "run_4",
      now: () => 1,
      emit: h.emit,
      drainAndEmit: h.drainAndEmit,
      eventSink: h.eventSink,
      usage: USAGE,
      buildError: (message) => ({ code: "adapter_error", message }),
      transform: redact,
    });

    const event = h.emitted[0] as unknown as { message: string };
    expect(event.message).not.toContain(SECRET);
    expect(event.message).toContain("[REDACTED]");

    expect(h.finalized?.error?.code).toBe("adapter_error");
    expect(h.finalized?.error?.message).not.toContain(SECRET);
    expect(h.finalized?.error?.message).toContain("[REDACTED]");
  });

  it("stamps cost / durationMs via the stamp hook and honours setFailedStatus:false", async () => {
    const h = harness();
    await finalizeThrownFailure({
      events: [],
      err: new Error("e"),
      signal: undefined,
      runId: "run_5",
      now: () => 9000,
      emit: h.emit,
      drainAndEmit: h.drainAndEmit,
      eventSink: h.eventSink,
      usage: USAGE,
      setFailedStatus: false,
      stamp: (result) => {
        result.cost = 1.23;
        result.durationMs = 50;
      },
    });

    expect(h.finalized?.status).toBeUndefined();
    expect(h.finalized?.cost).toBe(1.23);
    expect(h.finalized?.durationMs).toBe(50);
    expect(h.finalized?.usage).toEqual(USAGE);
  });

  it("stamps `terminalStatus` instead of the default failed (runner-enforced timeout)", async () => {
    const h = harness();
    await finalizeThrownFailure({
      events: [],
      err: new Error("run timeout watchdog"),
      signal: undefined,
      runId: "run_timeout",
      now: () => 1,
      emit: h.emit,
      drainAndEmit: h.drainAndEmit,
      eventSink: h.eventSink,
      usage: USAGE,
      terminalStatus: "timeout",
      buildError: () => ({ code: "timeout", message: "Run timed out after 5s" }),
      stamp: (result) => {
        result.durationMs = 5000;
      },
    });

    expect(h.finalized?.status).toBe("timeout");
    expect(h.finalized?.error).toEqual({ code: "timeout", message: "Run timed out after 5s" });
    expect(h.finalized?.durationMs).toBe(5000);
  });

  it("ignores `terminalStatus` when setFailedStatus:false (status stays unset)", async () => {
    const h = harness();
    await finalizeThrownFailure({
      events: [],
      err: new Error("e"),
      signal: undefined,
      runId: "run_ts_off",
      now: () => 1,
      emit: h.emit,
      drainAndEmit: h.drainAndEmit,
      eventSink: h.eventSink,
      usage: USAGE,
      setFailedStatus: false,
      terminalStatus: "timeout",
    });
    expect(h.finalized?.status).toBeUndefined();
  });

  it("defaults the terminal status to failed when terminalStatus is omitted", async () => {
    const h = harness();
    await finalizeThrownFailure({
      events: [],
      err: new Error("boom"),
      signal: undefined,
      runId: "run_default",
      now: () => 1,
      emit: h.emit,
      drainAndEmit: h.drainAndEmit,
      eventSink: h.eventSink,
      usage: USAGE,
    });
    expect(h.finalized?.status).toBe("failed");
  });

  it("leaves usage unset when undefined is passed (Pi bridge-null path)", async () => {
    const h = harness();
    await finalizeThrownFailure({
      events: [],
      err: new Error("early"),
      signal: undefined,
      runId: "run_6",
      now: () => 1,
      emit: h.emit,
      drainAndEmit: h.drainAndEmit,
      eventSink: h.eventSink,
      usage: undefined,
      setFailedStatus: false,
    });
    expect(h.finalized).toBeDefined();
    expect(h.finalized?.usage).toBeUndefined();
    expect(h.finalized?.cost).toBeUndefined();
  });
});
