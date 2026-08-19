// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  classifyClientTurnError,
  clientTurnErrorFromMarker,
  clientTurnErrorMarker,
  refusalDetail,
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

describe("refusalDetail", () => {
  const problem = (body: Record<string, unknown>) => JSON.stringify(body);

  it("returns the refusal's own sentence, which is what the user must act on", () => {
    expect(
      refusalDetail(
        new Error(
          problem({
            type: "https://docs.appstrate.dev/errors/usage-not-allowed",
            title: "Usage not allowed",
            status: 402,
            detail: "Votre organisation n'a plus de crédits.",
            code: "quota_exceeded",
          }),
        ),
      ),
    ).toBe("Votre organisation n'a plus de crédits.");
  });

  it("reads the same document off a bare string error", () => {
    expect(refusalDetail(problem({ status: 401, detail: "Reconnectez votre abonnement." }))).toBe(
      "Reconnectez votre abonnement.",
    );
  });

  it("withholds a non-refusal detail, which carries internal text", () => {
    // `beforeUsage` failing closed puts the raw thrown message in `detail`.
    expect(
      refusalDetail(problem({ status: 500, detail: 'relation "x" does not exist' })),
    ).toBeUndefined();
  });

  it("declines anything that is not a problem document", () => {
    expect(refusalDetail("Upstream model error (status 503)")).toBeUndefined();
    expect(refusalDetail("{not json")).toBeUndefined();
    expect(refusalDetail(problem({ status: 402 }))).toBeUndefined();
    expect(refusalDetail(undefined)).toBeUndefined();
  });
});
