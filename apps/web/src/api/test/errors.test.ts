// SPDX-License-Identifier: Apache-2.0

/**
 * The one statement of which failures are worth asking again: the query retry
 * and the pairing poll both read it.
 */

import { describe, it, expect } from "bun:test";
import { ApiError, isTransientError } from "../errors.ts";

describe("isTransientError", () => {
  it("holds for a server failure, a timeout and a rate limit", () => {
    for (const status of [500, 502, 503, 408, 429]) {
      expect(isTransientError(new ApiError("transient", "transient", status))).toBe(true);
    }
  });

  it("holds for a failure that carries no answer from the API", () => {
    expect(isTransientError(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("does not hold for a refusal", () => {
    for (const status of [400, 401, 403, 404, 410]) {
      expect(isTransientError(new ApiError("refused", "refused", status))).toBe(false);
    }
  });
});
