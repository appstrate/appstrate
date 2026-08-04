// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  classifyClientTurnError,
  clientTurnErrorFromMarker,
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
