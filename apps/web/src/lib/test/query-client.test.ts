// SPDX-License-Identifier: Apache-2.0

/**
 * The two defaults every screen inherits from the shared client: a refused
 * query is not asked again, and a refused mutation is never silent.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { toast } from "sonner";
import { ApiError } from "../../api/errors.ts";
import { queryClient, reportsMutationError, shouldRetryQuery } from "../query-client.ts";
import { i18nReady } from "../../i18n.ts";

await i18nReady;

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

describe("failed mutations", () => {
  let toastError: Mock<typeof toast.error>;

  beforeEach(() => {
    toastError = spyOn(toast, "error").mockImplementation(() => "");
  });
  afterEach(() => {
    toastError.mockRestore();
    queryClient.getMutationCache().clear();
  });

  const fail = (options: Parameters<typeof reportsMutationError>[0] = {}) =>
    queryClient
      .getMutationCache()
      .build(queryClient, {
        ...options,
        mutationFn: () => Promise.reject(new ApiError("blocked_url", "URL is blocked", 400)),
      } as never)
      .execute(undefined)
      .catch(() => undefined);

  it("toasts the refusal of a mutation that handles nothing itself", async () => {
    await fail();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0]![0])).toContain("URL is blocked");
  });

  it("stays quiet when the hook reports the failure itself", async () => {
    await fail({ onError: () => {} });

    expect(toastError).not.toHaveBeenCalled();
  });

  it("stays quiet when the hook hands the failure to its callers", async () => {
    await fail({ meta: { errorHandledByCaller: true } });

    expect(toastError).not.toHaveBeenCalled();
  });
});
