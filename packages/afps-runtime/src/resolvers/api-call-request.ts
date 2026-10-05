// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

/**
 * The caller half of an `api_call`, prepared the same way on every path (platform proxy, sidecar,
 * local CLI): the target and the caller's headers go in as `{{field}}` templates and come out as
 * wire values, or as the one reason they cannot be sent.
 */

import { isHttpFieldValue } from "@appstrate/afps-shared/delivery-http";
import { substituteVars, unresolvedPlaceholders } from "./template-vars.ts";

/** Why a request cannot be prepared. Each path words its own refusal; nothing was sent. */
export type ApiCallRequestIssue =
  | { kind: "unresolved_placeholder"; in: "target"; keys: string[] }
  | { kind: "unresolved_placeholder"; in: "header"; header: string; keys: string[] }
  /** The caller's own value is no HTTP field value (one a credential spoils is the engine's). */
  | { kind: "invalid_header"; header: string };

export interface PreparedApiCallRequest {
  /** The target, substituted. It holds decrypted values: for the wire, never for a message. */
  url: string;
  /** The caller's headers, auth scheme repaired, substituted. */
  headers: Record<string, string>;
  /** Names of the headers a credential value went into: a hop leaving the allowlist strips them. */
  credentialHeaders: string[];
  /** The target and header templates the values were substituted into: `credentialUrlPolicy`'s input. */
  templates: string[];
}

/**
 * `Bearer{{token}}` → `Bearer {{token}}` on an `Authorization` / `Proxy-Authorization` TEMPLATE:
 * an LLM writing the header sometimes drops the space, which substitution would expand to
 * `Bearerghp_…`, a 401 upstream. Anchored on `{{`: on a resolved value it would split any secret
 * whose first bytes spell a scheme name (`tokenlive_sk_123`, #988).
 */
function repairAuthScheme(headerName: string, template: string): string {
  const lower = headerName.toLowerCase();
  if (lower !== "authorization" && lower !== "proxy-authorization") return template;
  return template.replace(/^(Bearer|Basic|Token)(?=\{\{)/i, "$1 ");
}

/**
 * Substitute `fields` into `target` and `callerHeaders`. Refuses, in this order and before
 * substituting anything: a target placeholder `fields` does not hold; then, header by header, a
 * value that is no HTTP field value and a placeholder `fields` does not hold.
 */
export function prepareApiCallRequest(
  target: string,
  callerHeaders: Readonly<Record<string, string>>,
  fields: Readonly<Record<string, string>>,
): { ok: true; request: PreparedApiCallRequest } | { ok: false; issue: ApiCallRequestIssue } {
  const unresolvedInTarget = unresolvedPlaceholders(target, fields);
  if (unresolvedInTarget.length > 0) {
    return {
      ok: false,
      issue: { kind: "unresolved_placeholder", in: "target", keys: unresolvedInTarget },
    };
  }

  const headers: Record<string, string> = {};
  const credentialHeaders: string[] = [];
  const templates = [target];
  for (const [header, written] of Object.entries(callerHeaders)) {
    const template = repairAuthScheme(header, written);
    if (!isHttpFieldValue(template))
      return { ok: false, issue: { kind: "invalid_header", header } };
    const keys = unresolvedPlaceholders(template, fields);
    if (keys.length > 0) {
      return { ok: false, issue: { kind: "unresolved_placeholder", in: "header", header, keys } };
    }
    templates.push(template);
    headers[header] = substituteVars(template, fields);
    if (headers[header] !== template) credentialHeaders.push(header);
  }

  return {
    ok: true,
    request: { url: substituteVars(target, fields), headers, credentialHeaders, templates },
  };
}
