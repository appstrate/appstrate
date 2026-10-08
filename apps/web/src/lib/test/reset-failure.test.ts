// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import { isRevocationFailure, resetFailure } from "../reset-failure.ts";

describe("a refusal whose new password was nonetheless written", () => {
  const revocationFailed = new ApiError("credential_change_revocation_failed", "", 500);

  it("is recognised by its code alone", () => {
    expect(isRevocationFailure(revocationFailed)).toBe(true);
    expect(isRevocationFailure(new ApiError("INVALID_PASSWORD", "", 400))).toBe(false);
    expect(isRevocationFailure(new Error("network"))).toBe(false);
  });

  it("is told apart from an invalid reset link", () => {
    expect(resetFailure(revocationFailed)).toBe("revocation_failed");
    expect(resetFailure(new ApiError("INVALID_TOKEN", "", 400))).toBe("invalid_token");
    expect(resetFailure(new Error("network"))).toBe("invalid_token");
  });
});
