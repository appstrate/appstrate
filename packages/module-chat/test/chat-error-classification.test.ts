// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  classifyClientTurnError,
  clientTurnErrorFromMarker,
  clientTurnErrorFromProblem,
  clientTurnErrorMarker,
} from "../src/turn-error.ts";

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

  it("round-trips only the stable category through transient stream markers", () => {
    const classified = classifyClientTurnError("private opaque backend details");
    const marker = clientTurnErrorMarker(classified);
    expect(marker).not.toContain("private opaque backend details");
    expect(clientTurnErrorFromMarker(marker)).toEqual({ category: "unknown", retryable: true });
  });
});

describe("clientTurnErrorFromProblem", () => {
  const quota = JSON.stringify({
    type: "https://docs.appstrate.dev/errors/usage-not-allowed",
    title: "Usage not allowed",
    status: 402,
    detail: "Credit quota exceeded for org ef820ed9-1db0-4f3c-a4bd-d6941e3b2160",
    code: "quota_exceeded",
  });

  it("recovers the refusal code from the body the transport throws verbatim", () => {
    expect(clientTurnErrorFromProblem(new Error(quota))).toEqual({
      category: "credential_unavailable",
      retryable: false,
      code: "quota_exceeded",
    });
  });

  it("reads the same document off a bare string error", () => {
    expect(clientTurnErrorFromProblem(quota)?.code).toBe("quota_exceeded");
  });

  it("keeps the status classification when the code is one we have no message for", () => {
    expect(
      clientTurnErrorFromProblem(
        JSON.stringify({ status: 429, code: "surprise_new_code", detail: "slow down" }),
      ),
    ).toEqual({ category: "rate_limited", retryable: true });
  });

  it("declines anything that is not a problem document", () => {
    expect(clientTurnErrorFromProblem("Upstream model error (status 503)")).toBeUndefined();
    expect(clientTurnErrorFromProblem("{not json")).toBeUndefined();
    expect(clientTurnErrorFromProblem(undefined)).toBeUndefined();
  });
});
