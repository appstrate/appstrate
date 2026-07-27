// SPDX-License-Identifier: Apache-2.0

/**
 * Producer ↔ consumer contract for Pi tool results.
 *
 * The Pi engine's tool layer (`toPiToolResult` / `mcpResultToPi`, then
 * `withTurnBudgetNote`) writes the shape the chat UI (`extractRunId`,
 * `extractRunStatus`, `deriveToolPhase`) reads. Both sides had tests and both
 * passed while the run card was broken in production: the producer tests
 * asserted the note's text, the UI tests unwrapped hand-written envelopes, and
 * nothing fed one into the other. So this file builds the payload with the REAL
 * producer functions and asserts the REAL consumer functions — a change to the
 * result shape on either side fails here.
 *
 * Fixtures are the payload shapes observed on the wire, not invented ones (the
 * identifiers themselves are anonymised).
 */

import { describe, expect, it } from "bun:test";
import {
  mcpResultToPi,
  toPiToolResult,
  withTurnBudgetNote,
  type PiTurnBudget,
} from "../src/pi-chat/mcp-tools.ts";
import { extractRunId, extractRunStatus } from "../src/ui/run-events.ts";
import { deriveToolPhase } from "../src/ui/tool-result.ts";

const NOW = 1_800_000_000_000;

/** Fixed clock + step count so the appended note is byte-stable. */
const BUDGET: PiTurnBudget = {
  deadlineAt: NOW + 9 * 60_000 + 54_000,
  stepCount: () => 1,
  now: () => NOW,
};

/** What the UI sees for a completed tool call. */
const complete = (result: unknown) => ({ status: { type: "complete" }, result });

describe("Pi tool result → chat UI (producer/consumer boundary)", () => {
  it("appends a model-facing note the UI must tolerate", () => {
    const result = withTurnBudgetNote(toPiToolResult({ id: "run_1" }), BUDGET);

    // The hazard this whole file guards: the payload is no longer the only text
    // part of the model channel.
    expect(result.content).toHaveLength(2);
    expect(result.content[1]?.text).toStartWith("[turn budget]");
  });

  it("reads a succeeded run_and_wait result", () => {
    const payload = {
      id: "run_11111111-1111-4111-8111-111111111111",
      packageId: "@inline/r-11111111-1111-4111-8111-111111111112",
      status: "success",
      done: true,
      result: { output: { done: true } },
    };
    const result = withTurnBudgetNote(toPiToolResult(payload), BUDGET);

    expect(extractRunId(result)).toBe(payload.id);
    expect(extractRunStatus(result)).toBe("success");
    expect(deriveToolPhase(complete(result))).toBe("success");
  });

  it("reads a cancelled run_and_wait result", () => {
    const payload = {
      id: "run_22222222-2222-4222-8222-222222222221",
      packageId: "@inline/r-22222222-2222-4222-8222-222222222222",
      status: "cancelled",
      done: true,
      error: "Cancelled by user",
    };
    const result = withTurnBudgetNote(toPiToolResult(payload), BUDGET);

    expect(extractRunId(result)).toBe(payload.id);
    expect(extractRunStatus(result)).toBe("cancelled");
    // A cancellation carries a non-empty `error`, which `isErrorPayload` treats
    // as a failure. This phase is inert in the card once a run id exists:
    // `StatusIcon` ignores `phase` whenever the run has a status, and the
    // destructive styling + error line are gated on `!runId && phase ===
    // "error"`. The card reads the run's own `cancelled` status and shows the
    // muted "Annulé" line.
    expect(deriveToolPhase(complete(result))).toBe("error");
  });

  it("reads a run launched through the forwarded invoke_operation path", () => {
    // Forwarded MCP tools return the HTTP envelope verbatim, so the run id sits
    // under `body`, and the text arrives pretty-printed by the platform.
    const envelope = {
      status: 201,
      body: {
        id: "run_33333333-3333-4333-8333-333333333333",
        packageId: "@acme/compteur",
        status: "pending",
      },
    };
    const result = withTurnBudgetNote(
      mcpResultToPi({ content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] }),
      BUDGET,
    );

    expect(extractRunId(result)).toBe(envelope.body.id);
    expect(extractRunStatus(result)).toBe("pending");
    expect(deriveToolPhase(complete(result))).toBe("success");
  });

  it("still surfaces a failed forwarded call as an error", () => {
    const envelope = {
      status: 412,
      body: { title: "Missing Integration Connection", status: 412 },
    };
    const result = withTurnBudgetNote(
      mcpResultToPi({ content: [{ type: "text", text: JSON.stringify(envelope) }] }),
      BUDGET,
    );

    expect(extractRunId(result)).toBeUndefined();
    expect(deriveToolPhase(complete(result))).toBe("error");
  });
});
