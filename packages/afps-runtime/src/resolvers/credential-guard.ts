// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/** Credential-exfiltration guard of the three `api_call` paths: docs/architecture/SIDECAR.md. */

import {
  isHostUnboundedUriPattern,
  matchesAuthorizedUriSpec,
  wildcardMatchStaysWithinBound,
} from "@appstrate/afps-shared/authorized-uris";
import { referencesField } from "./template-vars.ts";

/** Why a call is refused before anything is sent; {@link urlPolicyRefusalMessage} says it. */
export type UrlPolicyRefusal = "unrendered" | "exfiltration" | "beyond_bound" | "unauthorized";

export interface CredentialUrlPolicy {
  substitutesCredential: boolean;
  /** allow_all_uris after the downgrade (false whenever the call carries a credential). */
  allowAllUris: boolean;
  refuse: UrlPolicyRefusal | null;
}

/**
 * False when every entry matching `url` reaches it only past its literal registrable domain.
 * A URL that does not parse, or that no entry matches, is the caller's allowlist gate's to refuse.
 */
export function credentialStaysWithinBound(
  url: string,
  authorizedUris: readonly string[],
): boolean {
  const matching = authorizedUris.filter((p) => matchesAuthorizedUriSpec(p, url));
  return (
    matching.length === 0 ||
    matching.some((p) => wildcardMatchStaysWithinBound(p, new URL(url).hostname))
  );
}

/** The one pre-send decision of the three `api_call` paths; `fetchApiCall` gates the targets. */
export function credentialUrlPolicy(input: {
  /** Rendered: a credential must stay inside the bound of what it matched. */
  target: string;
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
  } else if (carriesCredential && !credentialStaysWithinBound(input.target, input.authorizedUris)) {
    refuse = "beyond_bound";
  } else if (!allowAllUris && noAllowlist) refuse = "unauthorized";
  return { substitutesCredential, allowAllUris, refuse };
}

/** Shared with the sidecar MITM listener. */
export function beyondBoundReason(host: string): string {
  return `${host}'s registrable domain lies outside the literal part of every wildcard entry that matches it; list that host in authorized_uris`;
}

/** Values to scrub from an echoed host: none when untemplated, where scrubbing is an oracle. */
export function redactionFields(
  policy: CredentialUrlPolicy,
  fields: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return policy.substitutesCredential ? fields : {};
}

/**
 * The refusal's message. Names no value: a field that failed to render may be a secret, so
 * `targetHost` is the target's host as its template names it (`templateHost`).
 */
export function urlPolicyRefusalMessage(
  refusal: UrlPolicyRefusal,
  integrationId: string,
  targetHost: string,
): string {
  switch (refusal) {
    case "unrendered":
      return `Integration "${integrationId}": the connection's URL does not render the integration's authorized_uris allowlist; fix the connection (an absolute http(s) URL).`;
    case "exfiltration":
      return `Call for integration "${integrationId}" carries a credential (substituted into an agent-controlled URL, header, or body, or injected by the proxy) but the integration declares no authorized_uris allowlist that names its hosts; refusing to prevent credential exfiltration.`;
    case "beyond_bound":
      return `Call for integration "${integrationId}" carries a credential: ${beyondBoundReason(targetHost)}.`;
    case "unauthorized":
      return `Integration "${integrationId}" declares no authorized_uris and not allow_all_uris; every target is forbidden.`;
  }
}
