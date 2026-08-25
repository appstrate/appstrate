// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import { turnErrorState } from "../src/ui/turn-error-state.ts";
import { clientTurnErrorMarker, clientTurnErrorForCategory } from "../src/turn-error.ts";

/** Echo the key so a test asserts WHICH sentence was chosen, not its wording. */
const t = (key: string) => key;

/**
 * `turnErrorState` reads an assistant-ui message. A message with no bound
 * source message falls back to itself, so a plain literal reaches the persisted
 * path — provided it carries what `turnMetadataFromMessage` requires to accept
 * the envelope at all: `metadata.appstrate.turn` with the three step counters.
 * `turn()` supplies those so each test states only the error fields it is about.
 */
const message = (m: Record<string, unknown>) => m as never;

const turn = (fields: Record<string, unknown>) => ({
  metadata: {
    appstrate: {
      turn: { stepCount: 1, maxSteps: 30, maxStepsReached: false, ...fields },
    },
  },
});

const problem = (body: Record<string, unknown>) => new Error(JSON.stringify(body));

describe("turnErrorState", () => {
  it("is null for a turn that did not fail", () => {
    expect(turnErrorState(message({ status: { type: "complete" } }), t)).toBeNull();
    expect(turnErrorState(message({}), t)).toBeNull();
  });

  it("localizes the persisted category, which survives reload", () => {
    expect(
      turnErrorState(
        message(
          turn({
            finishReason: "error",
            errorCategory: "rate_limited",
            errorRetryable: true,
            requestId: "req_abc123",
          }),
        ),
        t,
      ),
    ).toEqual({ text: "turn.error.rateLimited", retryable: true, requestId: "req_abc123" });
  });

  it("degrades a legacy category-less turn to the generic failure", () => {
    // Turns persisted before the category existed carried the provider's own
    // string. It is no longer read, so nothing unclassified reaches the UI.
    expect(
      turnErrorState(message(turn({ finishReason: "error", errorText: "boom" })), t),
    ).toMatchObject({ text: "turn.error.unknown" });
  });

  it("surfaces the cause of a deadline turn that was failing all along", () => {
    // The deadline notice is a real persisted text part rendered above this
    // alert, so the user reads BOTH: "this turn hit its time limit" and why it
    // was going nowhere. Retry follows the cause, not the ceiling.
    expect(
      turnErrorState(
        message(
          turn({
            finishReason: "deadline",
            errorCategory: "upstream_unavailable",
            errorRetryable: true,
            requestId: "req_slow1",
          }),
        ),
        t,
      ),
    ).toEqual({ text: "turn.error.upstreamUnavailable", retryable: true, requestId: "req_slow1" });
  });

  it("takes retryable from the cause on a deadline turn, not from the deadline", () => {
    expect(
      turnErrorState(
        message(
          turn({
            finishReason: "deadline",
            errorCategory: "credential_unavailable",
            errorRetryable: false,
          }),
        ),
        t,
      ),
    ).toMatchObject({ text: "turn.error.credentialUnavailable", retryable: false });
  });

  it("adds no sentence to a deadline turn that carried no cause", () => {
    // Nothing failed — the turn simply ran out of clock, and the notice already
    // says so. A generic "generation failed" here would contradict it and read
    // as a second, different verdict on the same turn.
    expect(turnErrorState(message(turn({ finishReason: "deadline" })), t)).toBeNull();
  });

  it("localizes an in-stream failure from its marker", () => {
    expect(
      turnErrorState(
        message({
          status: {
            type: "incomplete",
            reason: "error",
            error: clientTurnErrorMarker(clientTurnErrorForCategory("upstream_unavailable")),
          },
        }),
        t,
      ),
    ).toEqual({ text: "turn.error.upstreamUnavailable", retryable: true, requestId: undefined });
  });

  it("gives a pre-stream refusal its own sentence and no retry", () => {
    expect(
      turnErrorState(
        message({
          status: {
            type: "incomplete",
            reason: "error",
            error: problem({
              status: 402,
              code: "quota_exceeded",
              detail: "Credit quota exceeded for org 1",
            }),
          },
        }),
        t,
      ),
    ).toEqual({ text: "turn.error.quotaExceeded", retryable: false, requestId: undefined });
  });

  it("degrades a refusal code it has no sentence for to the generic failure", () => {
    // A server-side code added after this build must not render a missing key.
    expect(
      turnErrorState(
        message({
          status: {
            type: "incomplete",
            reason: "error",
            error: problem({ status: 402, code: "invented_later" }),
          },
        }),
        t,
      ),
    ).toEqual({ text: "turn.error.unknown", retryable: true, requestId: undefined });
  });

  it("lets the status decide, not the code — a known code off a 500 is not a refusal", () => {
    // The guard in `refusalCode` is only observable here: a code that IS in the
    // key map, arriving with a status that does not mean "you must act". A
    // module failing closed describes an internal fault, so it must not borrow
    // a refusal's sentence — and must keep its Retry, since retrying may work.
    expect(
      turnErrorState(
        message({
          status: {
            type: "incomplete",
            reason: "error",
            error: problem({
              status: 500,
              code: "quota_exceeded",
              detail: 'relation "x" does not exist',
            }),
          },
        }),
        t,
      ),
    ).toEqual({ text: "turn.error.unknown", retryable: true, requestId: undefined });
  });
});
