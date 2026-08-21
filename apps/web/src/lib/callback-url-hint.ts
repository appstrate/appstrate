// SPDX-License-Identifier: Apache-2.0

/**
 * `{{callback_url}}` substitution for `auths.<key>.callback_url_hint`
 * (AFPS §7.10).
 *
 * The placeholder is resolved by the CONSUMER, not the publisher: the callback
 * URL depends on the deployment (`APP_URL`) and on whether the resolved OAuth
 * client overrides it, neither of which a manifest author can know. Rendering
 * it verbatim shows the admin a literal `{{callback_url}}` in the middle of
 * the one string they are supposed to paste into the provider's console.
 */

/** Placeholder the manifest writes. Consumer-substituted, NOT a runtime expression. */
const CALLBACK_URL_PLACEHOLDER = "{{callback_url}}";

/**
 * Substitute every `{{callback_url}}` occurrence with the effective callback.
 *
 * Raw substitution, no percent-encoding: a hint is prose as often as it is a
 * deep link ("Set the authorized redirect URI to: {{callback_url}}"), and
 * encoding prose would show the admin an unusable mangled string. In the
 * deep-link form the value lands in a query parameter, where RFC 3986 §3.4
 * already permits the `:` and `/` an unencoded URL contributes.
 */
export function substituteCallbackUrl(hint: string, callbackUrl: string): string {
  return hint.split(CALLBACK_URL_PLACEHOLDER).join(callbackUrl);
}
