// SPDX-License-Identifier: Apache-2.0

/**
 * The query retry rule (#1678): a definitive client error used to be replayed —
 * every 404 page issued its request twice before showing the error.
 */

import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.ts";
import { shouldRetryQuery } from "../query-client.ts";

const apiError = (status: number) => new ApiError("some_code", "detail", status);

describe("shouldRetryQuery", () => {
  it("does not replay an answer the server would give again", () => {
    for (const status of [400, 401, 403, 404, 409, 410, 412, 422]) {
      expect(shouldRetryQuery(0, apiError(status))).toBe(false);
    }
  });

  it("retries once what may succeed next time", () => {
    for (const status of [408, 429, 500, 502, 503]) {
      expect(shouldRetryQuery(0, apiError(status))).toBe(true);
      expect(shouldRetryQuery(1, apiError(status))).toBe(false);
    }
    // A network failure or an unparseable error page carries no status.
    expect(shouldRetryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetryQuery(1, new TypeError("Failed to fetch"))).toBe(false);
  });

  it("issues a 404 once through a real client", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: 0 } },
    });
    let calls = 0;
    await qc
      .fetchQuery({
        queryKey: ["gone"],
        queryFn: () => {
          calls++;
          return Promise.reject(apiError(404));
        },
      })
      .catch(() => undefined);
    expect(calls).toBe(1);
  });
});
