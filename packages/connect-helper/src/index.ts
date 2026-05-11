// SPDX-License-Identifier: Apache-2.0

/**
 * `@appstrate/connect` — programmatic surface for the front-end-initiated
 * OAuth model-provider connection flow. The CLI helper (`appstrate-connect`
 * binary, see `cli.ts`) is the primary consumer; library callers can
 * wire individual modules to embed the flow inside larger tools.
 */

export {
  runLoopbackOAuth,
  SLUG_TO_PROVIDER_ID,
  PROVIDER_ID_TO_SLUG,
  DISPLAY_NAME,
  DEFAULT_LABEL,
  type ConnectProviderSlug,
  type LoopbackCallbacks,
  type NormalisedOAuthCredentials,
} from "./loopback-oauth.ts";

export {
  encodePairingToken,
  decodePairingToken,
  hashPairingSecret,
  type PairingTokenHeader,
  type DecodedPairingToken,
} from "./pairing-token.ts";

export {
  postImport,
  ImportRequestError,
  type ImportResult,
  type ImportError,
} from "./import-client.ts";
