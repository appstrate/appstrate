// SPDX-License-Identifier: Apache-2.0

/**
 * A run keeps whatever ended it verbatim; `runErrorText` says it in the reader's language from
 * what the server classified — the run's `status` and its `model_error` — and shows the stored
 * text as written when nothing classified it. It never reads that text.
 */

import { describe, expect, it } from "bun:test";
import type { TFunction } from "i18next";
import { findRunErrorReason, runErrorText } from "../run-error.ts";

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

  it("names the journal's runtime-version reason before the provider's own sentence", () => {
    const refusal = modelError(
      "invalid_request",
      400,
      "Claude Code 2.1.280 does not support this model",
    );
    const run = { status: "failed", error: "400 …", model_error: refusal };
    expect(runErrorText(run, t, "runtime_version_too_old")).toBe("run.error.runtimeVersionTooOld");
    // A cancellation stays a cancellation, whatever the journal says.
    expect(runErrorText({ status: "cancelled", error: null }, t, "runtime_version_too_old")).toBe(
      "run.cancelledByUser",
    );
  });
});

describe("findRunErrorReason", () => {
  const adapterError = (data: unknown) => ({ event: "adapter_error", data });

  it("reads a known reason off the run's adapter_error row", () => {
    const logs = [
      { event: "progress", data: { error_reason: "runtime_version_too_old" } },
      adapterError({
        error_category: "invalid_request",
        error_retryable: false,
        error_reason: "runtime_version_too_old",
      }),
    ];
    expect(findRunErrorReason(logs)).toBe("runtime_version_too_old");
  });

  it("is null without logs, without a reason, or with a reason it has no sentence for", () => {
    expect(findRunErrorReason(undefined)).toBeNull();
    expect(findRunErrorReason([adapterError({ error_category: "invalid_request" })])).toBeNull();
    expect(findRunErrorReason([adapterError(null)])).toBeNull();
    expect(findRunErrorReason([adapterError({ error_reason: "something_else" })])).toBeNull();
    expect(findRunErrorReason([adapterError({ error_reason: "toString" })])).toBeNull();
    // Only the runner's refusal row carries the reason.
    expect(
      findRunErrorReason([
        { event: "progress", data: { error_reason: "runtime_version_too_old" } },
      ]),
    ).toBeNull();
  });

  it("leaves the run's sentence as it is when the journal names no reason", () => {
    const run = {
      status: "failed",
      error: "400 …",
      model_error: modelError("invalid_request", 400, "prompt is too long"),
    };
    const reason = findRunErrorReason([adapterError({ error_reason: "something_else" })]);
    expect(runErrorText(run, t, reason)).toBe(
      'run.error.model {"status":400,"message":"prompt is too long"}',
    );
  });
});
