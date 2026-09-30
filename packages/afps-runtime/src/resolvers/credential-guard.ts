// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/** Credential-exfiltration guard of the three `api_call` paths: docs/architecture/SIDECAR.md. */

import { isHostUnboundedUriPattern } from "@appstrate/afps-shared/credential-template";
import { referencesField } from "./template-vars.ts";

export interface CredentialUrlPolicy {
  substitutesCredential: boolean;
  /** allow_all_uris after the downgrade (false whenever the call carries a credential). */
  allowAllUris: boolean;
  /** A credential is carried and authorized_uris is empty or leaves the host to the caller. */
  refuse: boolean;
}

export function credentialUrlPolicy(input: {
  /** Every string the call runs placeholder substitution on. */
  templates: Iterable<string>;
  fields: Readonly<Record<string, string>>;
  allowAllUris: boolean;
  authorizedUris: readonly string[];
  /** The proxy itself adds a credential header to the call. */
  injectsCredential: boolean;
}): CredentialUrlPolicy {
  let substitutesCredential = false;
  for (const template of input.templates) {
    if (referencesField(template, input.fields)) {
      substitutesCredential = true;
      break;
    }
  }
  const carriesCredential = substitutesCredential || input.injectsCredential;
  return {
    substitutesCredential,
    allowAllUris: input.allowAllUris && !carriesCredential,
    refuse:
      carriesCredential &&
      (input.authorizedUris.length === 0 || input.authorizedUris.some(isHostUnboundedUriPattern)),
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
  return `Call for integration "${integrationId}" carries a credential (substituted into an agent-controlled URL, header, or body, or injected by the proxy) but the integration declares no authorized_uris allowlist that names its hosts; refusing to prevent credential exfiltration.`;
}

/**
 * A declared allowlist that renders to nothing for this connection (its URL field is unset or
 * not an absolute http(s) URL): refuse every target — never the SSRF-only no-allowlist branch.
 */
export function allowlistUnrendered(input: {
  declaredUris: readonly string[];
  authorizedUris: readonly string[];
  allowAllUris: boolean;
}): boolean {
  return !input.allowAllUris && input.declaredUris.length > 0 && input.authorizedUris.length === 0;
}

/** Names no value: the connection field that failed to render may be a secret. */
export const UNRENDERED_ALLOWLIST_REFUSAL =
  "the connection's URL does not render the integration's authorized_uris allowlist; fix the connection (an absolute http(s) URL).";
