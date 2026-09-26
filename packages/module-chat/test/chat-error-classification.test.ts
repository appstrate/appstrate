// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  classifyClientTurnError,
  clientTurnErrorFromMarker,
  clientTurnErrorMarker,
  readRefusal,
} from "../src/turn-error.ts";

/**
 * The RULES moved to `@appstrate/core/model-error` (tested there, case for
 * case). What is left here is the chat-specific wrapper: unwrapping the error
 * object, handing the engine's own retry verdict to the shared classifier, and
 * the marker round-trip that keeps raw provider text server-side.
 */
describe("classifyClientTurnError", () => {
  it("turns an aliased 402 into actionable provider-neutral metadata", () => {
    expect(
      classifyClientTurnError(
        new Error("Upstream model error (status 402). Request ID req_public_123"),
      ),
    ).toEqual({
      category: "credential_unavailable",
      retryable: false,
      requestId: "req_public_123",
    });
  });

  it("classifies throttling as retryable without exposing provider internals", () => {
    expect(classifyClientTurnError("429 rate limit from hidden-backend")).toMatchObject({
      category: "rate_limited",
      retryable: true,
    });
  });

  it("lets an explicit 400 win over the generic upstream wrapper", () => {
    expect(classifyClientTurnError("Upstream model error (status 400)")).toEqual({
      category: "invalid_request",
      retryable: false,
    });
  });

  it("classifies 5xx and unknown failures without retaining raw provider text", () => {
    expect(classifyClientTurnError("provider secret dump status 503")).toEqual({
      category: "upstream_unavailable",
      retryable: true,
    });
    expect(classifyClientTurnError("private opaque backend details")).toEqual({
      category: "unknown",
      retryable: true,
    });
  });

  it("reads the status off the error envelope, not only out of the prose", () => {
    expect(
      classifyClientTurnError(Object.assign(new Error("backend refused"), { status: 429 })),
    ).toMatchObject({ category: "rate_limited" });
  });

  it("round-trips only the stable category through transient stream markers", () => {
    const classified = classifyClientTurnError("private opaque backend details");
    const marker = clientTurnErrorMarker(classified);
    expect(marker).not.toContain("private opaque backend details");
    // Pinned as a literal, because `toEqual(classified)` alone passes trivially
    // for any input that produces no `requestId`.
    expect(clientTurnErrorFromMarker(marker)).toEqual({ category: "unknown", retryable: true });
    // The marker carries the CATEGORY only, and the two paths must still agree:
    // the UI reads a failed turn through whichever arrived first.
    expect(clientTurnErrorFromMarker(marker)).toEqual(classified);
  });
});

describe("readRefusal", () => {
  const problem = (body: Record<string, unknown>) => JSON.stringify(body);

  it("reads whether the gate would admit the turn on the org's own credential", () => {
    const refusal = { status: 402, code: "quota_exceeded" };
    expect(readRefusal(problem({ ...refusal, own_credential_admitted: true }))).toEqual({
      code: "quota_exceeded",
      ownCredentialAdmitted: true,
    });
    // Only a literal `true` counts: absent, false or mistyped all mean "no".
    for (const own_credential_admitted of [undefined, false, "true", 1]) {
      expect(readRefusal(problem({ ...refusal, own_credential_admitted }))).toEqual({
        code: "quota_exceeded",
        ownCredentialAdmitted: false,
      });
    }
  });

  it("withholds a non-refusal code, which no user action can clear", () => {
    // `beforeUsage` failing closed rejects with 500 — an internal fault, not
    // something to hand the user a sentence about.
    expect(readRefusal(problem({ status: 500, code: "unexpected" }))).toBeUndefined();
  });

  it("declines anything that is not a problem document", () => {
    expect(readRefusal("Upstream model error (status 503)")).toBeUndefined();
    expect(readRefusal("{not json")).toBeUndefined();
    expect(readRefusal(undefined)).toBeUndefined();
    // Valid JSON that is not an object, or an object without the two fields
    // that make a refusal: the status guard is what rejects these, which is
    // why sniffing the string for a leading brace bought nothing.
    expect(readRefusal("503")).toBeUndefined();
    expect(readRefusal("null")).toBeUndefined();
    expect(readRefusal("[402]")).toBeUndefined();
    expect(readRefusal(problem({ status: 402 }))).toBeUndefined();
    expect(readRefusal(problem({ code: "quota_exceeded" }))).toBeUndefined();
  });
});
