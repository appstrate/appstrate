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
 * refused when there is none. The origin of every credential field holding an
 * absolute http(s) URL joins that allowlist — the connection owner typed that
 * endpoint (`webhook_url`, `site_url`), the agent did not choose it.
 */

import { referencesField } from "./template-vars.ts";

export interface CredentialUrlPolicy {
  /** A template references a credential field. */
  substitutesCredential: boolean;
  /** allow_all_uris after the downgrade (false whenever substitutesCredential). */
  allowAllUris: boolean;
  /** authorized_uris to enforce on the target and every hop: the declared list, plus — when a
   *  credential is templated — `${origin}/**` for each credential field holding an absolute http(s) URL. */
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
  if (!substitutesCredential) {
    return {
      substitutesCredential,
      allowAllUris: input.allowAllUris,
      authorizedUris,
      refuse: false,
    };
  }
  for (const value of Object.values(input.fields)) {
    const origin = httpOrigin(value);
    if (origin && !authorizedUris.includes(`${origin}/**`)) authorizedUris.push(`${origin}/**`);
  }
  return {
    substitutesCredential,
    allowAllUris: false,
    authorizedUris,
    refuse: authorizedUris.length === 0,
  };
}

/** Origin of an absolute `http:`/`https:` URL, else null (relative, `javascript:`, non-URL). */
function httpOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
}
