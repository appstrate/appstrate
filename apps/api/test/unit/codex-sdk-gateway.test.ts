// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-function tests for the Codex credential-vend endpoint (no DB).
 */

import { describe, it, expect } from "bun:test";
import {
  codexAuthErrorResponse,
  codexSubscriptionAuthError,
} from "../../src/services/llm-proxy/codex-sdk-gateway.ts";
import { gone, internalError } from "../../src/lib/errors.ts";

describe("codexAuthErrorResponse", () => {
  it("is a 401 authentication_error envelope", async () => {
    const res = codexAuthErrorResponse();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("authentication_error");
  });
});

describe("codexSubscriptionAuthError", () => {
  it("maps a 410 to a 401 auth envelope", () => {
    expect(codexSubscriptionAuthError(gone("gone", "subscription revoked"))?.status).toBe(401);
  });
  it("returns null for any other error", () => {
    expect(codexSubscriptionAuthError(new Error("boom"))).toBeNull();
    expect(codexSubscriptionAuthError(internalError())).toBeNull();
  });
});
