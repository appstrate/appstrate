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

/**
 * 409 — the org already has a subscription Stripe is holding, so Checkout is the wrong
 * door: completing it would create a SECOND subscription and bill the organization twice.
 * `POST /api/billing/plan` modifies the one that exists.
 */
export function subscriptionExists(): ApiError {
  return new ApiError({
    status: 409,
    code: "subscription_exists",
    title: "Conflict",
    detail:
      "This organization already has an active subscription. Change its plan instead of starting a new checkout.",
  });
}

/**
 * 409 — a plan change on an account with no subscription to change; the way in is
 * Checkout.
 */
export function noActiveSubscription(): ApiError {
  return new ApiError({
    status: 409,
    code: "no_active_subscription",
    title: "Conflict",
    detail: "This organization has no active subscription to change. Start a checkout instead.",
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
