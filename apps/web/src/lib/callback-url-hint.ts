// SPDX-License-Identifier: Apache-2.0

// `{{callback_url}}` in `auths.<key>.callback_url_hint` (AFPS §7.10) is resolved by the
// consumer: the callback depends on the deployment (`APP_URL`) and the OAuth client override.

/** Consumer-substituted, NOT a runtime expression. */
const CALLBACK_URL_PLACEHOLDER = "{{callback_url}}";

/** Raw substitution, no percent-encoding: a hint is prose as often as a deep link. */
export function substituteCallbackUrl(hint: string, callbackUrl: string): string {
  return hint.split(CALLBACK_URL_PLACEHOLDER).join(callbackUrl);
}
