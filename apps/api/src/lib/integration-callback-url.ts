// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";

/**
 * Path of the shared OAuth redirect endpoint every integration connect flow
 * comes back through (`GET /api/integrations/callback`).
 */
export const INTEGRATION_CALLBACK_PATH = "/api/integrations/callback";

/**
 * The `redirect_uri` this instance sends to every integration authorization
 * server — and therefore the exact string an admin must register on their
 * BYO OAuth app at the provider.
 *
 * Single source of truth on purpose. The value is sent by the OAuth2 connect
 * strategy, registered by auto-DCR, and displayed in the admin UI; deriving
 * all three from here is what keeps the displayed string equal to the sent
 * one. A provider compares `redirect_uri` byte-for-byte, so a UI that
 * recomputed it from `window.location.origin` would show a plausible-looking
 * value whenever `APP_URL` drifts from the origin actually serving the SPA —
 * exactly the case where the admin needs to see the truth, not a guess.
 *
 * No normalization here: `APP_URL` is parsed to `url.origin` by the env schema
 * (`packages/env`), so it carries no path, no query and no trailing slash.
 */
export function integrationCallbackUrl(): string {
  return `${getEnv().APP_URL}${INTEGRATION_CALLBACK_PATH}`;
}

/** 22 base64url characters: 132 bits. */
const AUTHORIZATION_SERVER_TAG_LENGTH = 22;

export const INTEGRATION_TAGGED_CALLBACK_PATH = new RegExp(
  `^${INTEGRATION_CALLBACK_PATH}/[A-Za-z0-9_-]{${AUTHORIZATION_SERVER_TAG_LENGTH}}$`,
);

/** A redirect URI per server chosen per connection (AFPS §7.3, RFC 9700 §4.4). */
export function authorizationServerTag(issuer: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(issuer)
    .digest("base64url")
    .slice(0, AUTHORIZATION_SERVER_TAG_LENGTH);
}

export function integrationCallbackUrlFor(issuer: string): string {
  return `${integrationCallbackUrl()}/${authorizationServerTag(issuer)}`;
}
