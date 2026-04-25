// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for the unified-runner event-ingestion auth path.
 *
 * Kept free of db/client imports so unit tests can exercise the
 * signature-verification + sink-state assertions without spinning up a
 * database or setting every env var that `@appstrate/db` needs at module
 * load time.
 *
 * Consumers:
 *   - `middleware/verify-run-signature.ts`      — per-request check
 *   - `services/run-event-ingestion.ts`         — re-exported for callers
 *     that also want the ingest pipeline
 */

import { decrypt } from "@appstrate/connect";
import { verify } from "@appstrate/afps-runtime/events";
import { ApiError, gone } from "@appstrate/core/api-errors";
import type { RunSinkContext } from "../types/run-sink.ts";

/**
 * 410 with a specific `code` when the sink is not in a state to accept events.
 * Separate from the generic `gone()` helper so the code string (which is the
 * machine-readable reason) is under the caller's control.
 */
export function assertSinkOpen(run: RunSinkContext): void {
  if (run.sinkClosedAt) {
    throw gone(
      "run_sink_closed",
      `run ${run.id} sink was closed at ${run.sinkClosedAt.toISOString()}`,
    );
  }
  if (run.sinkExpiresAt && run.sinkExpiresAt.getTime() < Date.now()) {
    throw gone(
      "run_sink_expired",
      `run ${run.id} sink expired at ${run.sinkExpiresAt.toISOString()}`,
    );
  }
}

/**
 * Verify a signed request's headers against the run's stored secret. Throws
 * {@link ApiError} on failure with one of the documented wire-contract codes:
 *   - `missing_signature_headers`
 *   - `invalid_timestamp`
 *   - `timestamp_out_of_tolerance`
 *   - `invalid_signature`
 *
 * `body` MUST be the raw HTTP body bytes (stringified). JSON-re-serialising
 * the parsed envelope would produce a different byte sequence and fail the
 * HMAC check.
 */
export function verifyRunSignatureHeaders(input: {
  run: RunSinkContext;
  signatureHeader: string;
  msgIdHeader: string;
  timestampHeader: string;
  body: string;
}): void {
  if (!input.signatureHeader || !input.msgIdHeader || !input.timestampHeader) {
    throw new ApiError({
      status: 401,
      code: "missing_signature_headers",
      title: "Unauthorized",
      detail: "webhook-id, webhook-timestamp and webhook-signature headers are required",
    });
  }

  const timestampSec = Number(input.timestampHeader);
  if (!Number.isFinite(timestampSec)) {
    throw new ApiError({
      status: 401,
      code: "invalid_timestamp",
      title: "Unauthorized",
      detail: "webhook-timestamp is not a valid Unix timestamp",
    });
  }

  const secret = decrypt(input.run.sinkSecretEncrypted);

  const result = verify({
    signatureHeader: input.signatureHeader,
    msgId: input.msgIdHeader,
    timestampSec,
    body: input.body,
    secret,
  });

  if (!result.ok) {
    if (result.reason === "timestamp_outside_tolerance") {
      throw new ApiError({
        status: 401,
        code: "timestamp_out_of_tolerance",
        title: "Unauthorized",
        detail: "webhook-timestamp is outside the accepted tolerance window",
      });
    }
    throw new ApiError({
      status: 401,
      code: "invalid_signature",
      title: "Unauthorized",
      detail: "webhook-signature did not match the expected value",
    });
  }
}
