// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/** Credential-exfiltration guard of the three `api_call` paths: docs/architecture/SIDECAR.md. */

import { isHostUnboundedUriPattern } from "@appstrate/afps-shared/credential-template";
import type { ApiCallFailureCode } from "./api-call-engine.ts";
import { referencesField } from "./template-vars.ts";

/** Why a call is refused before anything is sent; {@link urlPolicyRefusalMessage} says it. */
export type UrlPolicyRefusal = "unrendered" | "exfiltration" | "unauthorized";

export interface CredentialUrlPolicy {
  substitutesCredential: boolean;
  /** allow_all_uris after the downgrade (false whenever the call carries a credential). */
  allowAllUris: boolean;
  refuse: UrlPolicyRefusal | null;
}

/** The one pre-send decision of the three `api_call` paths; `fetchApiCall` gates the targets. */
export function credentialUrlPolicy(input: {
  /** Every string the call runs placeholder substitution on. */
  templates: Iterable<string>;
  fields: Readonly<Record<string, string>>;
  allowAllUris: boolean;
  /** The manifest's list, before rendering. */
  declaredUris: readonly string[];
  /** The list rendered for the call's connection. */
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
  const allowAllUris = input.allowAllUris && !carriesCredential;
  const noAllowlist = input.authorizedUris.length === 0;
  let refuse: UrlPolicyRefusal | null = null;
  if (!allowAllUris && noAllowlist && input.declaredUris.length > 0) refuse = "unrendered";
  else if (
    carriesCredential &&
    (noAllowlist || input.authorizedUris.some(isHostUnboundedUriPattern))
  ) {
    refuse = "exfiltration";
  } else if (!allowAllUris && noAllowlist) refuse = "unauthorized";
  return { substitutesCredential, allowAllUris, refuse };
}

/** Values to scrub from an echoed host: none when untemplated, where scrubbing is an oracle. */
export function redactionFields(
  policy: CredentialUrlPolicy,
  fields: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return policy.substitutesCredential ? fields : {};
}

/** Each refusal's shared failure code. */
export const URL_POLICY_REFUSAL_CODE = {
  unrendered: "unauthorized_target",
  unauthorized: "unauthorized_target",
  exfiltration: "credential_exfiltration_refused",
} as const satisfies Record<UrlPolicyRefusal, ApiCallFailureCode>;

/** The refusal's message. Names no value: a field that failed to render may be a secret. */
export function urlPolicyRefusalMessage(refusal: UrlPolicyRefusal, integrationId: string): string {
  switch (refusal) {
    case "unrendered":
      return `Integration "${integrationId}": the connection's URL does not render the integration's authorized_uris allowlist; fix the connection (an absolute http(s) URL).`;
    case "exfiltration":
      return `Call for integration "${integrationId}" carries a credential (substituted into an agent-controlled URL, header, or body, or injected by the proxy) but the integration declares no authorized_uris allowlist that names its hosts; refusing to prevent credential exfiltration.`;
    case "unauthorized":
      return `Integration "${integrationId}" declares no authorized_uris and not allow_all_uris; every target is forbidden.`;
  }
}
