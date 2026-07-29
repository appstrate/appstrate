// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Unit tests for the `appstrate.*` envelope builders. They are pure functions
 * of their inputs (no ambient clock, no I/O), so the assertions are on the
 * exact emitted shape — a consumer reading `data->>'…'` out of `run_logs`
 * depends on these keys.
 */

import { describe, it, expect } from "bun:test";
import {
  buildToolResultProgress,
  buildTurnProgress,
  TURN_PROGRESS_EVENT,
} from "../../src/runner/event-builders.ts";

const BASE = { runId: "run_builders", timestamp: 1_700_000_000_000 };

describe("buildToolResultProgress — durationMs", () => {
  it("emits durationMs into data when supplied", () => {
    const ev = buildToolResultProgress(BASE, {
      tool: "bash",
      result: "ok",
      isError: false,
      toolCallId: "c1",
      durationMs: 1234,
    });

    expect(ev.data).toEqual({
      tool: "bash",
      result: "ok",
      isError: false,
      toolCallId: "c1",
      durationMs: 1234,
    });
  });

  it("omits the key entirely when durationMs is undefined", () => {
    const ev = buildToolResultProgress(BASE, { tool: "bash", result: "ok", isError: false });

    expect(ev.data).toEqual({ tool: "bash", result: "ok", isError: false });
    expect("durationMs" in (ev.data as Record<string, unknown>)).toBe(false);
  });

  it("keeps a zero duration — a sub-millisecond call is not a missing one", () => {
    const ev = buildToolResultProgress(BASE, {
      tool: "noop",
      result: null,
      isError: false,
      durationMs: 0,
    });

    expect((ev.data as { durationMs: number }).durationMs).toBe(0);
  });
});

describe("buildTurnProgress", () => {
  it("derives contextTokens as input + cacheRead + cacheWrite", () => {
    const ev = buildTurnProgress(BASE, {
      index: 7,
      latencyMs: 4200,
      inputTokens: 120,
      outputTokens: 900,
      cacheReadTokens: 96_000,
      cacheWriteTokens: 4_000,
    });

    expect(ev.type).toBe("appstrate.progress");
    expect(ev.data).toEqual({
      event: TURN_PROGRESS_EVENT,
      index: 7,
      latencyMs: 4200,
      inputTokens: 120,
      outputTokens: 900,
      cacheReadTokens: 96_000,
      cacheWriteTokens: 4_000,
      // Output is generated, not re-read — excluded on purpose.
      contextTokens: 100_120,
    });
  });

  it("omits latencyMs when the caller could not observe the turn start", () => {
    const ev = buildTurnProgress(BASE, {
      index: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect("latencyMs" in (ev.data as Record<string, unknown>)).toBe(false);
  });

  it("carries contextWindow when the runner states one", () => {
    const ev = buildTurnProgress(BASE, {
      index: 3,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      contextWindow: 200_000,
    });

    expect(ev.data).toEqual({
      event: TURN_PROGRESS_EVENT,
      index: 3,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      contextTokens: 100,
      contextWindow: 200_000,
    });
  });

  it("omits contextWindow entirely when the runner cannot state one", () => {
    const ev = buildTurnProgress(BASE, {
      index: 5,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    const data = ev.data as Record<string, unknown>;
    expect("contextWindow" in data).toBe(false);
  });

  it("carries the discriminator and the envelope identity", () => {
    const ev = buildTurnProgress(BASE, {
      index: 2,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
    });

    expect(ev.runId).toBe(BASE.runId);
    expect(ev.timestamp).toBe(BASE.timestamp);
    expect((ev.data as { event: string }).event).toBe("turn");
    expect(ev.message).toBe("Turn 2 — 80 context tokens, 20 generated");
  });
});
