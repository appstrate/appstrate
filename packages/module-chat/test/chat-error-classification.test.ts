// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { classifyClientTurnError } from "../src/chat-stream.ts";

describe("classifyClientTurnError", () => {
  it("turns an aliased 402 into actionable provider-neutral metadata", () => {
    expect(
      classifyClientTurnError(
        new Error("Upstream model error (status 402). Request ID req_public_123"),
      ),
    ).toEqual({
      text: expect.stringContaining("configuration d’accès ou de facturation"),
      category: "credential_unavailable",
      retryable: false,
      requestId: "req_public_123",
    });
  });

  it("classifies throttling as retryable without exposing provider internals", () => {
    expect(classifyClientTurnError("429 rate limit from hidden-backend")).toMatchObject({
      text: "Le modèle a atteint sa limite de débit. Réessayez dans quelques instants.",
      category: "rate_limited",
      retryable: true,
    });
  });
});
