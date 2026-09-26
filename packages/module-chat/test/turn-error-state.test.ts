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

/**
 * `message.status.error` as assistant-ui actually stores it: the runtime runs
 * every thrown value through `toAssistantError` (`@assistant-ui/core`, not
 * re-exported by `@assistant-ui/react`), which turns an Error — and a string —
 * into `{ code: "unknown", message }`. Mirrored here rather than imported.
 */
const assistantError = (message: string) => ({ code: "unknown", message });

/** A pre-stream refusal: the transport throws the problem+json body verbatim. */
const problem = (body: Record<string, unknown>) => assistantError(JSON.stringify(body));

const failed = (error: unknown) =>
  message({ status: { type: "incomplete", reason: "error", error } });

const member = { canManageBilling: false, hasOwnCredentialModel: false };
const manager = { canManageBilling: true, hasOwnCredentialModel: false };
const BILLING = { label: "turn.error.manageBilling", href: "/org-settings/billing" };

describe("turnErrorState", () => {
  it("is null for a turn that did not fail", () => {
    expect(turnErrorState(message({ status: { type: "complete" } }), t, member)).toBeNull();
    expect(turnErrorState(message({}), t, member)).toBeNull();
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
        member,
      ),
    ).toEqual({ text: "turn.error.rateLimited", retryable: true, requestId: "req_abc123" });
  });

  it("degrades a legacy category-less turn to the generic failure", () => {
    // Turns persisted before the category existed carried the provider's own
    // string. It is no longer read, so nothing unclassified reaches the UI.
    expect(
      turnErrorState(message(turn({ finishReason: "error", errorText: "boom" })), t, member),
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
        member,
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
        member,
      ),
    ).toMatchObject({ text: "turn.error.credentialUnavailable", retryable: false });
  });

  it("adds no sentence to a deadline turn that carried no cause", () => {
    // Nothing failed — the turn simply ran out of clock, and the notice already
    // says so. A generic "generation failed" here would contradict it and read
    // as a second, different verdict on the same turn.
    expect(turnErrorState(message(turn({ finishReason: "deadline" })), t, member)).toBeNull();
  });

  it("localizes an in-stream failure from its marker", () => {
    expect(
      turnErrorState(failed(assistantError("appstrate:chat-turn-error:rate_limited")), t, member),
    ).toEqual({
      text: "turn.error.rateLimited",
      retryable: true,
      requestId: undefined,
      action: undefined,
    });
    expect(
      turnErrorState(
        failed(
          assistantError(clientTurnErrorMarker(clientTurnErrorForCategory("upstream_unavailable"))),
        ),
        t,
        member,
      ),
    ).toMatchObject({ text: "turn.error.upstreamUnavailable", retryable: true });
  });

  /** A refusal as rendered: no retry, no request id. */
  const refused = (text: string, action?: typeof BILLING) => ({
    text,
    retryable: false,
    requestId: undefined,
    action,
  });

  describe.each([
    ["quota_exceeded", "turn.error.quotaExceeded"],
    ["subscription_blocked", "turn.error.subscriptionBlocked"],
  ])("%s", (code, text) => {
    const refusal = (own_credential_admitted?: boolean) =>
      failed(problem({ status: 402, code, detail: "org 1", own_credential_admitted }));
    const withModel = { hasOwnCredentialModel: true };

    it("links a billing manager to billing, and sends anyone else to them", () => {
      expect(turnErrorState(refusal(), t, manager)).toEqual(refused(text, BILLING));
      expect(turnErrorState(refusal(), t, member)).toEqual(
        refused(`${text} turn.error.contactAdmin`),
      );
    });

    it("names another model when the gate would admit one and the org has one", () => {
      expect(turnErrorState(refusal(true), t, { ...manager, ...withModel })).toEqual(
        refused(`${text} turn.error.otherModel`, BILLING),
      );
      expect(turnErrorState(refusal(true), t, { ...member, ...withModel })).toEqual(
        refused(`${text} turn.error.contactAdmin turn.error.otherModel`),
      );
    });

    it("does not name another model the gate would refuse too", () => {
      // An own-credential model in the catalog proves nothing about its price:
      // only the gate's answer does.
      for (const flag of [undefined, false]) {
        expect(turnErrorState(refusal(flag), t, { ...manager, ...withModel })).toEqual(
          refused(text, BILLING),
        );
      }
    });

    it("does not name another model when the org has none to pick", () => {
      expect(turnErrorState(refusal(true), t, manager)).toEqual(refused(text, BILLING));
    });
  });

  it("keeps one sentence for a dead credential, whoever reads it", () => {
    const reconnect = failed(problem({ status: 409, code: "needs_reconnection" }));
    for (const context of [member, { canManageBilling: true, hasOwnCredentialModel: true }]) {
      expect(turnErrorState(reconnect, t, context)).toEqual(
        refused("turn.error.needsReconnection"),
      );
    }
  });

  it("degrades a refusal code it has no sentence for to the generic failure", () => {
    // A server-side code added after this build must not render a missing key.
    expect(
      turnErrorState(failed(problem({ status: 402, code: "invented_later" })), t, manager),
    ).toEqual({
      text: "turn.error.unknown",
      retryable: true,
      requestId: undefined,
      action: undefined,
    });
    // Nor may a code that happens to name an Object.prototype member.
    expect(
      turnErrorState(failed(problem({ status: 402, code: "toString" })), t, manager),
    ).toMatchObject({ text: "turn.error.unknown", retryable: true });
  });

  it("lets the status decide, not the code — a known code off a 500 is not a refusal", () => {
    // The guard in `readRefusal` is only observable here: a code that IS in the
    // copy table, arriving with a status that does not mean "you must act". A
    // module failing closed describes an internal fault, so it must not borrow
    // a refusal's sentence — and must keep its Retry, since retrying may work.
    expect(
      turnErrorState(
        failed(
          problem({
            status: 500,
            code: "quota_exceeded",
            detail: 'relation "x" does not exist',
          }),
        ),
        t,
        manager,
      ),
    ).toEqual({
      text: "turn.error.unknown",
      retryable: true,
      requestId: undefined,
      action: undefined,
    });
  });
});
