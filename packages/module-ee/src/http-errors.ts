// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { Context } from "hono";
import { ApiError } from "@appstrate/core/api-errors";

/**
 * Render an `ApiError` as an RFC 9457 `application/problem+json` Response,
 * matching the platform's core error contract.
 *
 * EE routes mount into the SAME Hono app as core routes, so emitting the
 * same shape (type/title/status/detail/code/requestId + `Request-Id` header)
 * keeps the API surface uniform — a client gets the same error envelope from
 * `/api/billing` as from `/api/runs`. We render locally rather than throwing
 * for the platform's error handler so the behavior is identical with or without
 * that middleware (e.g. EE's own test app) and robust against
 * module-boundary `instanceof` quirks.
 */
export function problemJson(c: Context, err: ApiError): Response {
  const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
  const headers: Record<string, string> = {
    "content-type": "application/problem+json",
    "request-id": requestId,
  };
  if (err.retryAfter !== undefined) headers["retry-after"] = String(err.retryAfter);
  if (err.headers) Object.assign(headers, err.headers);
  return new Response(JSON.stringify(err.toProblemDetail(requestId)), {
    status: err.status,
    headers,
  });
}

// ── EE-specific ApiError builders ────────────────────────────────────────
// Reuse core factories (invalidRequest, forbidden, …) where the generic code
// fits; these cover the EE-only codes / statuses core has no factory for.

export function noBillingAccount(): ApiError {
  return new ApiError({
    status: 404,
    code: "no_billing_account",
    title: "Not Found",
    detail: "No billing account found for this org.",
  });
}

export function rateLimited(retryAfterSeconds: number): ApiError {
  return new ApiError({
    status: 429,
    code: "rate_limited",
    // Title matches the platform's own rate-limit error for the shared code/type.
    title: "Rate Limited",
    detail: "Too many requests. Please try again shortly.",
    retryAfter: retryAfterSeconds,
  });
}

export function paymentServiceUnavailable(): ApiError {
  return new ApiError({
    status: 503,
    code: "payment_service_unavailable",
    title: "Service Unavailable",
    detail: "Payment service unavailable. Please try again later.",
  });
}

/**
 * 409 — this deployment pairs `@appstrate/module-ee` with a platform that does not
 * report the execution facts admission is priced from (see
 * `assertExecutionFacts`). Permanent until an operator changes the deployment.
 *
 * The status is chosen for what the three admission seams DO with it, not only
 * for its prose:
 *
 *  - It must be an `ApiError` at all. The scheduler branches on exactly that
 *    (`apps/api/src/services/scheduler.ts`): an `ApiError` becomes a FAILED RUN
 *    ROW plus an `onRunStatusChange` the dashboard renders, while anything else
 *    falls through to an outer catch that logs one line and lets the BullMQ job
 *    COMPLETE — no run row, no event, `nextRunAt` re-armed. A schedule that
 *    looks healthy while silently doing nothing is the exact degrade this
 *    refusal exists to remove, one seam over.
 *  - It must be 4xx. `/api/llm-proxy` renders a non-`ApiError` as a 500, and the
 *    Pi SDK retries 429/5xx natively — so a 5xx (or a 429) turns one permanent
 *    misconfiguration into an unbounded retry storm against the credential.
 *    A terminal 4xx stops on the first response.
 *  - 409 rather than 402/403: this is not a quota rejection (402 means "top up",
 *    and the org's balance is irrelevant here) and not an authorization denial.
 *    RFC 9110 §15.5.10 — a conflict with the current state of the resource — is
 *    what an unserviceable platform/module version pair is, and 409 is the one
 *    4xx core exposes with a caller-chosen `code` (`conflict()`).
 *
 * `detail` is deliberately value-free (#50): it reaches API consumers as the
 * RFC 9457 `detail` AND is written verbatim onto the failed run row above. The
 * values that diagnose it are logged, structured, at the point of refusal.
 */
export function platformVersionUnsupported(): ApiError {
  return new ApiError({
    status: 409,
    code: "platform_version_unsupported",
    // Matches core's own 409 title so the shared status reads uniformly.
    title: "Conflict",
    detail:
      "Billing cannot admit this operation: this deployment runs an unsupported platform version. Contact your administrator.",
  });
}
