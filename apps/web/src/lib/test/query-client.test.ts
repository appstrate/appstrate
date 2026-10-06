// SPDX-License-Identifier: Apache-2.0

/**
 * The retry default every screen inherits from the shared client: a refused
 * query is not asked again.
 */

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import { shouldRetryQuery } from "../query-client.ts";

describe("shouldRetryQuery", () => {
  it("does not re-ask a refusal", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(shouldRetryQuery(0, new ApiError("refused", "refused", status))).toBe(false);
    }
  });

  it("retries once what a second attempt can change", () => {
    for (const status of [408, 429, 500, 503]) {
      expect(shouldRetryQuery(0, new ApiError("transient", "transient", status))).toBe(true);
    }
    expect(shouldRetryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetryQuery(1, new TypeError("Failed to fetch"))).toBe(false);
  });
});
