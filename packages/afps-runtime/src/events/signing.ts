// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Standard Webhooks signing (https://www.standardwebhooks.com/).
 *
 * HMAC-SHA256 over `msgId.timestamp.body`. Base64 signature, versioned
 * prefix (`v1,`) so future algorithm rotation is non-breaking.
 *
 * Secrets are raw UTF-8 strings. The Appstrate run-secret issuer may
 * choose any opaque format (e.g. 32 random bytes base64url-encoded);
 * the runtime treats it as an opaque key.
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §5, §10.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignedEnvelopeHeaders {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
}

export interface SignOptions {
  msgId: string;
  /** Unix seconds. Integer. */
  timestampSec: number;
  /** Exact bytes that will be transmitted as the HTTP body. */
  body: string;
  /** Raw secret (UTF-8 bytes). */
  secret: string;
}

/**
 * Compute the Standard Webhooks signature headers for one message.
 */
export function sign(opts: SignOptions): SignedEnvelopeHeaders {
  const signedContent = `${opts.msgId}.${opts.timestampSec}.${opts.body}`;
  const signature = createHmac("sha256", opts.secret).update(signedContent).digest("base64");
  return {
    "webhook-id": opts.msgId,
    "webhook-timestamp": String(opts.timestampSec),
    "webhook-signature": `v1,${signature}`,
  };
}

export interface VerifyOptions extends SignOptions {
  /** `webhook-signature` header value, possibly a space-separated list. */
  signatureHeader: string;
  /** Max clock skew tolerated, in seconds. Default 300 (5 minutes). */
  toleranceSec?: number;
  /** Reference time (Unix seconds). Defaults to `Date.now() / 1000`. */
  nowSec?: number;
}

export type VerifyFailure =
  | { ok: false; reason: "timestamp_outside_tolerance" }
  | { ok: false; reason: "no_valid_signature" }
  | { ok: false; reason: "malformed_signature_header" };

export type VerifyResult = { ok: true } | VerifyFailure;

/**
 * Constant-time signature verification with replay-protection.
 *
 * Accepts signature lists (space-separated `v1,sig v1,sig2`) to allow
 * zero-downtime secret rotation.
 */
export function verify(opts: VerifyOptions): VerifyResult {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSec ?? 300;

  if (Math.abs(now - opts.timestampSec) > tolerance) {
    return { ok: false, reason: "timestamp_outside_tolerance" };
  }

  const parts = opts.signatureHeader.split(/\s+/).filter((s) => s.length > 0);
  if (parts.length === 0) {
    return { ok: false, reason: "malformed_signature_header" };
  }

  const expected = sign({
    msgId: opts.msgId,
    timestampSec: opts.timestampSec,
    body: opts.body,
    secret: opts.secret,
  })["webhook-signature"];
  const expectedBuf = Buffer.from(expected, "utf8");

  for (const part of parts) {
    if (!part.startsWith("v1,")) continue; // unknown version — skip (not a failure)
    const presentedBuf = Buffer.from(part, "utf8");
    if (presentedBuf.length !== expectedBuf.length) continue;
    if (timingSafeEqual(presentedBuf, expectedBuf)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "no_valid_signature" };
}
