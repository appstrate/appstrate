// SPDX-License-Identifier: Apache-2.0

/**
 * Turn-budget propagation (A1) and budget visibility (A5).
 *
 * Companion to `pi-chat-turn-control.test.ts`: that file covers what ENDS a turn,
 * this one covers what a turn is allowed to START — the single budget helper both
 * engines share, the refusal of a launch that cannot finish, and the budget the
 * model is shown on every step.
 */

import { describe, expect, it } from "bun:test";
import {
  CHAT_MIN_RUN_BUDGET_MS,
  CHAT_TURN_DEADLINE_MS,
  CHAT_TURN_SAFETY_MARGIN_MS,
  computeTurnRunBudget,
  formatTurnBudgetNote,
} from "@appstrate/core/chat-turn-metadata";
import type { RunAndWaitStep } from "@appstrate/core/run-and-wait-client";
import {
  decideRunAndWaitBudget,
  runAndWaitStepsWithinTurnBudget,
  type BudgetLogger,
} from "../src/run-budget.ts";
import { withTurnBudgetNote } from "../src/pi-chat/mcp-tools.ts";

const NOW = 1_800_000_000_000;

/** Capturing logger — dependency injection, never `mock.module()`. */
function captureLogger() {
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const log: BudgetLogger = {
    warn: (message, fields) => warnings.push({ message, ...(fields ? { fields } : {}) }),
  };
  return { log, warnings };
}

describe("computeTurnRunBudget", () => {
  it("hands a child call the remaining turn time minus the closing-step reserve", () => {
    const budget = computeTurnRunBudget(NOW + CHAT_TURN_DEADLINE_MS, NOW);
    expect(budget.remainingMs).toBe(CHAT_TURN_DEADLINE_MS);
    expect(budget.maxMs).toBe(CHAT_TURN_DEADLINE_MS - CHAT_TURN_SAFETY_MARGIN_MS);
    expect(budget.launchable).toBe(true);
    expect(budget.thin).toBe(false);
  });

  it("flags a thin — but still launchable — budget", () => {
    const budget = computeTurnRunBudget(NOW + 2 * 60_000 + CHAT_TURN_SAFETY_MARGIN_MS, NOW);
    expect(budget.maxMs).toBe(2 * 60_000);
    expect(budget.launchable).toBe(true);
    expect(budget.thin).toBe(true);
  });

  it("refuses below the launch floor", () => {
    // One millisecond under the floor, once the reserve is taken out.
    const budget = computeTurnRunBudget(
      NOW + CHAT_MIN_RUN_BUDGET_MS + CHAT_TURN_SAFETY_MARGIN_MS - 1,
      NOW,
    );
    expect(budget.launchable).toBe(false);
    // Exactly at the floor it launches — the boundary is inclusive.
    expect(
      computeTurnRunBudget(NOW + CHAT_MIN_RUN_BUDGET_MS + CHAT_TURN_SAFETY_MARGIN_MS, NOW)
        .launchable,
    ).toBe(true);
  });

  it("clamps a deadline already in the past (never negative)", () => {
    const budget = computeTurnRunBudget(NOW - 60_000, NOW);
    expect(budget).toEqual({ remainingMs: 0, maxMs: 0, launchable: false, thin: false });
  });
});

describe("decideRunAndWaitBudget", () => {
  it("grants the derived budget on an ample turn, silently", () => {
    const { log, warnings } = captureLogger();
    const decision = decideRunAndWaitBudget(
      { turnDeadlineAt: NOW + CHAT_TURN_DEADLINE_MS, engine: "ai-sdk", now: () => NOW },
      log,
    );
    expect(decision).toEqual({
      launch: true,
      maxMs: CHAT_TURN_DEADLINE_MS - CHAT_TURN_SAFETY_MARGIN_MS,
    });
    expect(warnings).toEqual([]);
  });

  it("warns when a run launches on a thin budget (the low remaining_ms trace)", () => {
    const { log, warnings } = captureLogger();
    const decision = decideRunAndWaitBudget(
      {
        turnDeadlineAt: NOW + 2 * 60_000 + CHAT_TURN_SAFETY_MARGIN_MS,
        engine: "subscription",
        chatSessionId: "chs_1",
        now: () => NOW,
      },
      log,
    );
    expect(decision).toEqual({ launch: true, maxMs: 2 * 60_000 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("thin turn budget");
    expect(warnings[0]?.fields).toMatchObject({
      engine: "subscription",
      chatSessionId: "chs_1",
      runBudgetMs: 2 * 60_000,
    });
  });

  it("refuses below the floor with an actionable, non-error payload", () => {
    const { log, warnings } = captureLogger();
    // The audited incident: 22 s left on the turn.
    const decision = decideRunAndWaitBudget(
      { turnDeadlineAt: NOW + 22_000, engine: "subscription", now: () => NOW },
      log,
    );
    expect(decision.launch).toBe(false);
    if (decision.launch) throw new Error("unreachable");
    expect(decision.payload).toMatchObject({
      launched: false,
      reason: "insufficient_turn_budget",
      remaining_ms: 22_000,
      run_budget_ms: 0,
      min_run_budget_ms: CHAT_MIN_RUN_BUDGET_MS,
    });
    // Not a failure: nothing that reads like one.
    expect(decision.payload).not.toHaveProperty("error");
    const message = String(decision.payload.message);
    expect(message).toContain("next turn");
    // The prose must agree with the structured fields AND with the budget note:
    // it states the turn's real remainder (22s — NOT the post-reserve 0s) and
    // quotes the threshold the gate applies (2m15s — NOT the bare 1m30s floor).
    // Both were wrong here while `formatTurnBudgetNote` was already right, which
    // is why the arithmetic now lives in ONE exported constant.
    expect(message).toContain("22s left");
    expect(message).toContain("2m15s");
    expect(message).not.toMatch(/0s of|only 0s/);
    expect(warnings[0]?.message).toContain("insufficient turn budget");
  });
});

describe("runAndWaitStepsWithinTurnBudget", () => {
  const clientOpts = {
    origin: "https://test.local",
    headers: {},
    fetch: (async () => {
      throw new Error("must not reach the platform");
    }) as unknown as typeof fetch,
  };

  it("passes the derived maxMs down to the run client", async () => {
    const seen: Array<number | undefined> = [];
    async function* fakeSteps(
      _args: unknown,
      opts: { maxMs?: number },
    ): AsyncGenerator<RunAndWaitStep> {
      seen.push(opts.maxMs);
      yield { payload: { id: "run_1", done: true } };
    }

    const steps: RunAndWaitStep[] = [];
    for await (const step of runAndWaitStepsWithinTurnBudget(
      { kind: "agent", scope: "@acme", name: "writer" },
      {
        ...clientOpts,
        budget: { turnDeadlineAt: NOW + CHAT_TURN_DEADLINE_MS, engine: "ai-sdk", now: () => NOW },
      },
      fakeSteps as never,
    )) {
      steps.push(step);
    }

    expect(seen).toEqual([CHAT_TURN_DEADLINE_MS - CHAT_TURN_SAFETY_MARGIN_MS]);
    expect(steps).toEqual([{ payload: { id: "run_1", done: true } }]);
  });

  it("never reaches the run client — nor the network — when the budget is spent", async () => {
    let called = false;
    async function* fakeSteps(): AsyncGenerator<RunAndWaitStep> {
      called = true;
      yield { payload: {} };
    }

    const steps: RunAndWaitStep[] = [];
    for await (const step of runAndWaitStepsWithinTurnBudget(
      { kind: "agent", scope: "@acme", name: "writer" },
      {
        ...clientOpts,
        budget: { turnDeadlineAt: NOW + 22_000, engine: "ai-sdk", now: () => NOW },
      },
      fakeSteps as never,
    )) {
      steps.push(step);
    }

    // No launch call at all → no `runs` row, no cost, no orphaned output.
    expect(called).toBe(false);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.isError).toBeUndefined();
    expect(steps[0]?.payload).toMatchObject({
      launched: false,
      reason: "insufficient_turn_budget",
    });
  });

  it("refuses through the REAL run client too (fetch is never invoked)", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      throw new Error("must not reach the platform");
    };

    const steps: RunAndWaitStep[] = [];
    for await (const step of runAndWaitStepsWithinTurnBudget(
      { kind: "agent", scope: "@acme", name: "writer" },
      {
        origin: "https://test.local",
        headers: {},
        fetch: fetchImpl,
        budget: { turnDeadlineAt: NOW + 1_000, engine: "subscription", now: () => NOW },
      },
    )) {
      steps.push(step);
    }

    expect(calls).toEqual([]);
    expect(steps[0]?.payload.reason).toBe("insufficient_turn_budget");
  });
});

describe("turn budget shown to the model (A5)", () => {
  it("states the real remaining time and step position", () => {
    const note = formatTurnBudgetNote({ remainingMs: 4 * 60_000 + 12_000, stepsUsed: 7 });
    expect(note).toContain("4m12s");
    expect(note).toContain("step 7/16");
    // The quoted threshold must be the one the GATE applies, not the bare floor:
    // `computeTurnRunBudget` spends the 45 s safety margin before comparing
    // against the 90 s floor, so a launch actually needs 2m15s of remaining time.
    // Quoting 1m30s here would tell a model with 1m50s left that it may launch,
    // and it would then be refused.
    expect(note).toContain("2m15s");
    expect(note).not.toContain("1m30s");
  });

  it("renders sub-minute budgets without a minute component", () => {
    expect(formatTurnBudgetNote({ remainingMs: 22_000, stepsUsed: 12 })).toContain("22s left");
  });

  it("rides the Pi engine's tool results, leaving the UI channel untouched", () => {
    const result = withTurnBudgetNote(
      { content: [{ type: "text", text: '{"id":"run_1"}' }], details: { id: "run_1" } },
      { deadlineAt: NOW + 90_000, stepCount: () => 5, now: () => NOW },
    );

    // The original model-visible payload is preserved; the note is appended.
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: '{"id":"run_1"}' });
    expect(result.content[1]?.text).toContain("1m30s left");
    expect(result.content[1]?.text).toContain("step 5/16");
    // `details` is the UI channel — it must not gain agent-facing chatter.
    expect(result.details).toEqual({ id: "run_1" });
  });
});
