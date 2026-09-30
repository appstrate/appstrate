// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/** Credential-exfiltration guard of the three `api_call` paths: docs/architecture/SIDECAR.md. */

import { referencesField } from "./template-vars.ts";

export interface CredentialUrlPolicy {
  substitutesCredential: boolean;
  /** allow_all_uris after the downgrade (false whenever substitutesCredential). */
  allowAllUris: boolean;
  /** A credential is templated and no authorized_uris is declared. */
  refuse: boolean;
}

export function credentialUrlPolicy(input: {
  /** Every string the call runs placeholder substitution on. */
  templates: Iterable<string>;
  fields: Readonly<Record<string, string>>;
  allowAllUris: boolean;
  authorizedUris: readonly string[];
}): CredentialUrlPolicy {
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
    refuse: substitutesCredential && input.authorizedUris.length === 0,
  };
}

/** Values to scrub from an echoed host: none when untemplated, where scrubbing is an oracle. */
export function redactionFields(
  policy: CredentialUrlPolicy,
  fields: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return policy.substitutesCredential ? fields : {};
}

export function exfiltrationRefusal(integrationId: string): string {
  return `Call for integration "${integrationId}" substitutes a credential into an agent-controlled URL, header, or body but the integration declares no authorized_uris allowlist; refusing to prevent credential exfiltration.`;
}
