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
 * Fixtures are the payloads observed on the wire (chat session
 * `chs_f9d3d9fc39284c9e81543ab5f1903930` and its neighbours), not invented ones.
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
    // part, so joining the parts and parsing the concatenation yields a string.
    expect(result.content).toHaveLength(2);
    expect(result.content[1]?.text).toStartWith("[turn budget]");
    expect(() => JSON.parse(result.content.map((p) => p.text).join(""))).toThrow();
  });

  it("reads a succeeded run_and_wait result", () => {
    const payload = {
      id: "run_65305695-9e33-4e69-8e04-b87615e63c09",
      packageId: "@inline/r-e2f3b9ab-8554-496d-acae-819b420134b1",
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
      id: "run_eb16d791-9326-4ce3-a415-8e22e168db1e",
      packageId: "@inline/r-7c2527d3-ad78-4c81-be27-9de36616c047",
      status: "cancelled",
      done: true,
      error: "Cancelled by user",
    };
    const result = withTurnBudgetNote(toPiToolResult(payload), BUDGET);

    expect(extractRunId(result)).toBe(payload.id);
    expect(extractRunStatus(result)).toBe("cancelled");
    // A cancellation carries a non-empty `error`, which `isErrorPayload` treats
    // as a failure — the card renders red. Recorded as the current behaviour,
    // not endorsed: a user-requested stop is not a tool error.
    expect(deriveToolPhase(complete(result))).toBe("error");
  });

  it("reads a run launched through the forwarded invoke_operation path", () => {
    // Forwarded MCP tools return the HTTP envelope verbatim, so the run id sits
    // under `body`, and the text arrives pretty-printed by the platform.
    const envelope = {
      status: 201,
      body: {
        id: "run_4c5ae2f5-ccc5-4238-9066-85df25b739c5",
        packageId: "@pierre-cabriere/compteur",
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
