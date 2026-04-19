// SPDX-License-Identifier: Apache-2.0

/**
 * Extract the `sub` (user id) + `email` identity claims from a JWT
 * access token by base64url-decoding the payload segment. The token
 * is NOT signature-verified: it was just obtained from an instance
 * the user chose, and every subsequent server call re-verifies it.
 *
 * Decoding locally also avoids a bootstrap problem — Better Auth's
 * `/get-session` only reads session cookies, and `/api/auth/*`
 * bypasses our OIDC bearer strategy, so there is no endpoint that
 * understands the freshly-minted JWT before we have persisted the
 * profile's org context.
 */

export interface AccessTokenIdentity {
  userId: string;
  email: string;
}

export function decodeAccessTokenIdentity(accessToken: string): AccessTokenIdentity {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed access token — expected JWT (header.payload.signature).");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed access token — payload is not valid base64url JSON.");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Malformed access token — payload is not an object.");
  }
  const claims = payload as Record<string, unknown>;
  const sub = claims.sub;
  const email = claims.email;
  if (typeof sub !== "string" || !sub) {
    throw new Error("Access token is missing the `sub` claim.");
  }
  if (typeof email !== "string" || !email) {
    throw new Error("Access token is missing the `email` claim.");
  }
  return { userId: sub, email };
}
