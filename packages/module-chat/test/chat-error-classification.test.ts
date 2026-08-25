// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  classifyClientTurnError,
  clientTurnErrorFromMarker,
  clientTurnErrorMarker,
  refusalCode,
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
    // The marker carries the CATEGORY only, and the two paths must still agree:
    // the UI reads a failed turn through whichever arrived first.
    expect(clientTurnErrorFromMarker(marker)).toEqual(classified);
  });
});

describe("refusalCode", () => {
  const problem = (body: Record<string, unknown>) => JSON.stringify(body);

  it("recovers the code from the body the transport throws verbatim", () => {
    expect(
      refusalCode(
        new Error(
          problem({
            type: "https://docs.appstrate.dev/errors/usage-not-allowed",
            title: "Usage not allowed",
            status: 402,
            detail: "Credit quota exceeded for org ef820ed9-1db0-4f3c-a4bd-d6941e3b2160",
            code: "quota_exceeded",
          }),
        ),
      ),
    ).toBe("quota_exceeded");
  });

  it("reads the same file off a bare string error", () => {
    expect(refusalCode(problem({ status: 401, code: "needs_reconnection" }))).toBe(
      "needs_reconnection",
    );
  });

  it("withholds a non-refusal code, which no user action can clear", () => {
    // `beforeUsage` failing closed rejects with 500 — an internal fault, not
    // something to hand the user a sentence about.
    expect(refusalCode(problem({ status: 500, code: "unexpected" }))).toBeUndefined();
  });

  it("declines anything that is not a problem document", () => {
    expect(refusalCode("Upstream model error (status 503)")).toBeUndefined();
    expect(refusalCode("{not json")).toBeUndefined();
    expect(refusalCode(undefined)).toBeUndefined();
    // Valid JSON that is not an object, or an object without the two fields
    // that make a refusal: the status guard is what rejects these, which is
    // why sniffing the string for a leading brace bought nothing.
    expect(refusalCode("503")).toBeUndefined();
    expect(refusalCode("null")).toBeUndefined();
    expect(refusalCode("[402]")).toBeUndefined();
    expect(refusalCode(problem({ status: 402 }))).toBeUndefined();
    expect(refusalCode(problem({ code: "quota_exceeded" }))).toBeUndefined();
  });
});
