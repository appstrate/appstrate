// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Credential-exfiltration guard, shared by the three `api_call` paths (the
 * sidecar's `executeApiCall`, the local resolver, the platform credential
 * proxy) so they cannot drift.
 *
 * A caller that templates a decrypted credential field (`{{field}}`) into the
 * target, a header or a substituted body loses `allow_all_uris`: the target
 * and every redirect hop are gated by `authorized_uris`, and the call is
 * refused when there is none. The allowlist is never widened from credential
 * values: a URL-valued field (`webhook_url`, `site_url`) is often a shared
 * multi-tenant origin, where any other tenant's endpoint would match.
 */

import { referencesField } from "./template-vars.ts";

export interface CredentialUrlPolicy {
  /** A template references a credential field. */
  substitutesCredential: boolean;
  /** allow_all_uris after the downgrade (false whenever substitutesCredential). */
  allowAllUris: boolean;
  /** authorized_uris to enforce on the target and every hop: the declared list, unchanged. */
  authorizedUris: string[];
  /** A credential is templated and authorizedUris is empty: refuse the call. */
  refuse: boolean;
}

export function credentialUrlPolicy(input: {
  /** Every string the call will run placeholder substitution on (target, header values, body strings/leaves). */
  templates: Iterable<string>;
  fields: Readonly<Record<string, string>>;
  allowAllUris: boolean;
  authorizedUris: readonly string[];
}): CredentialUrlPolicy {
  const authorizedUris = [...input.authorizedUris];
  let substitutesCredential = false;
  for (const template of input.templates) {
    if (referencesField(template, input.fields)) {
      substitutesCredential = true;
      break;
    }
  }
  return {
    substitutesCredential,
    allowAllUris: input.allowAllUris && !substitutesCredential,
    authorizedUris,
    refuse: substitutesCredential && authorizedUris.length === 0,
  };
}

/**
 * Credential values to scrub from a URL or host echoed back to the caller. Only
 * a call that templates a credential can carry one in its URL; scrubbing any
 * other call would tell the agent whether a guessed host matches a field.
 */
export function redactionFields<T>(
  policy: CredentialUrlPolicy,
  fields: Readonly<Record<string, T>>,
): Readonly<Record<string, T>> {
  return policy.substitutesCredential ? fields : {};
}
