// SPDX-License-Identifier: Apache-2.0

/**
 * Ephemeral sink-credential minting. Kept in `lib/` (pure, no db/env
 * imports) so unit tests can cover the URL + secret derivation without
 * spinning up a DB or reading `CONNECTION_ENCRYPTION_KEY`.
 */

import { randomBytes } from "node:crypto";

export interface SinkCredentials {
  /** Absolute URL — CLI plugs into `HttpSink.url`. */
  url: string;
  /** Absolute URL — CLI plugs into `HttpSink.finalizeUrl`. */
  finalizeUrl: string;
  /** Plaintext run secret — returned once, never retrievable. */
  secret: string;
  /** ISO-8601. */
  expiresAt: string;
}

/**
 * Derive the sink URLs + a fresh ephemeral secret for one run. The
 * caller encrypts `secret` at rest (via `@appstrate/connect.encrypt`)
 * before persisting; only the plaintext returned here is ever handed
 * back to the CLI.
 *
 * Secret is 32 bytes base64url-encoded → 43 ASCII chars. Base64url
 * (RFC 4648 §5) is chosen so the secret is safe inside HTTP headers
 * and env vars without any escaping.
 */
export function mintSinkCredentials(input: {
  runId: string;
  appUrl: string;
  ttlSeconds: number;
}): SinkCredentials {
  const base = input.appUrl.replace(/\/$/, "");
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
  return {
    url: `${base}/api/runs/${input.runId}/events`,
    finalizeUrl: `${base}/api/runs/${input.runId}/events/finalize`,
    secret,
    expiresAt,
  };
}
