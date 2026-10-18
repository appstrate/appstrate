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

/**
 * The namespace of the redirect URIs a Client ID Metadata Document lists (`…/callback/cimd/<tag>`),
 * apart from the ones DCR registers (`…/callback/<tag>`). Any server fetches any document, so a
 * server could be handed the document of another one; keeping the two namespaces apart means a
 * response on a document's redirect URI can only satisfy the state of a document client — which
 * requires RFC 9207 `iss` — and never that of a DCR or admin client that does not.
 */
const CLIENT_METADATA_CALLBACK_SEGMENT = "cimd";

export const INTEGRATION_TAGGED_CALLBACK_PATH = new RegExp(
  `^${INTEGRATION_CALLBACK_PATH}/(?:${CLIENT_METADATA_CALLBACK_SEGMENT}/)?[A-Za-z0-9_-]{${AUTHORIZATION_SERVER_TAG_LENGTH}}$`,
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

/** The redirect URI the metadata document of `issuer`'s server lists (and connect sends with it). */
export function clientMetadataCallbackUrlFor(issuer: string): string {
  return `${integrationCallbackUrl()}/${CLIENT_METADATA_CALLBACK_SEGMENT}/${authorizationServerTag(issuer)}`;
}

/** The `redirectTag` of a response on `/callback/cimd/:tag` (a document client's namespace). */
export function clientMetadataRedirectTag(tag: string): string {
  return `${CLIENT_METADATA_CALLBACK_SEGMENT}/${tag}`;
}

/**
 * The tag of a per-server redirect URI — `<tag>` for `…/callback/<tag>`, `cimd/<tag>` for a
 * document client's `…/callback/cimd/<tag>` —, `undefined` for the shared callback or any other URI. The connect flow records it in the OAuth state whenever the redirect URI it sends
 * carries one, so the callback refuses a response that comes back through another path.
 */
export function redirectTagOf(redirectUri: string): string | undefined {
  if (!URL.canParse(redirectUri)) return undefined;
  const { pathname } = new URL(redirectUri);
  return INTEGRATION_TAGGED_CALLBACK_PATH.test(pathname)
    ? pathname.slice(INTEGRATION_CALLBACK_PATH.length + 1)
    : undefined;
}
