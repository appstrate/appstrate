// SPDX-License-Identifier: Apache-2.0

/**
 * A run keeps whatever ended it verbatim; `runErrorText` says it in the reader's language from
 * what the server classified — the run's `status` and its `model_error` — and shows the stored
 * text as written when nothing classified it. It never reads that text.
 */

import { describe, expect, it } from "bun:test";
import type { TFunction } from "i18next";
import { runErrorText } from "../run-error.ts";

/** Echoes the key and its values, so the test reads which sentence was chosen. */
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as TFunction;

type Category =
  | "credential_unavailable"
  | "rate_limited"
  | "upstream_unavailable"
  | "invalid_request"
  | "unknown";
const modelError = (category: Category, status: number | null, message: string | null) => ({
  category,
  retryable: category !== "credential_unavailable" && category !== "invalid_request",
  status,
  message,
});
const failed = (error: string | null, model_error: ReturnType<typeof modelError> | null = null) =>
  runErrorText({ status: "failed", error, model_error }, t);

describe("runErrorText", () => {
  it("words a cancelled run as a member's cancellation, whatever its text", () => {
    expect(runErrorText({ status: "cancelled", error: "Cancelled by user" }, t)).toBe(
      "run.cancelledByUser",
    );
    // The same text on a failed run is not a cancellation.
    expect(failed("Cancelled by user")).toBe("Cancelled by user");
  });

  it("names a refused credential or a rate limit by its category", () => {
    expect(failed("401 …", modelError("credential_unavailable", 401, "invalid x-api-key"))).toBe(
      "run.error.modelRefused",
    );
    expect(failed("429 …", modelError("rate_limited", 429, "slow down"))).toBe(
      "run.error.modelRateLimited",
    );
  });

  it("carries the provider's own sentence with its status", () => {
    expect(failed("400 …", modelError("invalid_request", 400, "prompt is too long"))).toBe(
      'run.error.model {"status":400,"message":"prompt is too long"}',
    );
  });

  it("shows the stored text when nothing classified it, or the provider said nothing", () => {
    // Text shaped like a provider refusal is NOT parsed: with no `model_error`, it is shown.
    expect(failed('429 {"error":{"message":"slow down"}}')).toBe(
      '429 {"error":{"message":"slow down"}}',
    );
    expect(failed("400 {}", modelError("invalid_request", 400, null))).toBe("400 {}");
    expect(failed("fetch failed", modelError("unknown", null, null))).toBe("fetch failed");
    expect(failed(null)).toBe("");
  });
});
