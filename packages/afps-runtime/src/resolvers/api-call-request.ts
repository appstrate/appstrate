// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

/**
 * The caller half of an `api_call`, prepared the same way on every path (platform proxy, sidecar,
 * local CLI): the target, the caller's headers and the strings its body substitutes into go in as
 * `{{field}}` templates; the wire values come out, or every reason the call is not sent.
 */

import { isHttpFieldValue } from "@appstrate/afps-shared/delivery-http";
import { substituteVars, unresolvedPlaceholders } from "./template-vars.ts";

/** Why a request is not prepared: keys and header names, never a value. Each path words its own refusal. */
export type ApiCallRequestIssue =
  | { kind: "unresolved_placeholder"; in: "target" | "body"; keys: string[] }
  | { kind: "unresolved_placeholder"; in: "header"; header: string; keys: string[] }
  /** The caller's own value, as written, is no HTTP field value. */
  | { kind: "invalid_header"; header: string };

export interface ApiCallRequestTemplates {
  target: string;
  headers: Readonly<Record<string, string>>;
  /** Every string the body substitutes into; none when the body is sent as is. */
  bodyTemplates?: readonly string[];
  fields: Readonly<Record<string, string>>;
}

export interface PreparedApiCallRequest {
  /** The target, substituted. It holds decrypted values: for the wire, never for a message. */
  url: string;
  /** The caller's headers, auth scheme repaired, substituted. */
  headers: Record<string, string>;
  /** Names of the headers a credential value went into: a hop leaving the allowlist strips them. */
  credentialHeaders: string[];
  /** Every template of the call (target, headers as repaired, body): `credentialUrlPolicy`'s input. */
  templates: string[];
}

/**
 * `Bearer{{token}}` → `Bearer {{token}}` on an `Authorization` TEMPLATE: an LLM writing the header
 * sometimes drops the space, which substitution would expand to `Bearerghp_…`, a 401 upstream.
 * Anchored on `{{`: on a resolved value it would split any secret whose first bytes spell a scheme
 * name (`tokenlive_sk_123`, #988).
 */
function repairAuthScheme(headerName: string, template: string): string {
  if (headerName.toLowerCase() !== "authorization") return template;
  return template.replace(/^(Bearer|Basic|Token)(?=\{\{)/i, "$1 ");
}

/**
 * Substitute `fields` into the target and the caller's headers. Refused, with every issue in
 * this order: a target placeholder `fields` does not hold; per header, a value that is no HTTP
 * field value, else a placeholder `fields` does not hold; a body placeholder `fields` does not
 * hold. The body itself is substituted by the caller, whose shape it is.
 */
export function prepareApiCallRequest(
  call: ApiCallRequestTemplates,
):
  | { ok: true; request: PreparedApiCallRequest }
  | { ok: false; issues: [ApiCallRequestIssue, ...ApiCallRequestIssue[]] } {
  const { target, fields } = call;
  const bodyTemplates = call.bodyTemplates ?? [];
  const issues: ApiCallRequestIssue[] = [];

  const unresolvedInTarget = unresolvedPlaceholders(target, fields);
  if (unresolvedInTarget.length > 0) {
    issues.push({ kind: "unresolved_placeholder", in: "target", keys: unresolvedInTarget });
  }

  const headers: Record<string, string> = {};
  const credentialHeaders: string[] = [];
  const templates = [target];
  for (const [header, written] of Object.entries(call.headers)) {
    const template = repairAuthScheme(header, written);
    if (!isHttpFieldValue(template)) {
      issues.push({ kind: "invalid_header", header });
      continue;
    }
    const keys = unresolvedPlaceholders(template, fields);
    if (keys.length > 0) {
      issues.push({ kind: "unresolved_placeholder", in: "header", header, keys });
      continue;
    }
    templates.push(template);
    // Nothing is left unresolved here; `keepUnresolved` only says a field is never blanked.
    headers[header] = substituteVars(template, fields, { keepUnresolved: true });
    if (headers[header] !== template) credentialHeaders.push(header);
  }

  const unresolvedInBody = [
    ...new Set(bodyTemplates.flatMap((template) => unresolvedPlaceholders(template, fields))),
  ];
  if (unresolvedInBody.length > 0) {
    issues.push({ kind: "unresolved_placeholder", in: "body", keys: unresolvedInBody });
  }

  const [first, ...rest] = issues;
  if (first) return { ok: false, issues: [first, ...rest] };
  return {
    ok: true,
    request: {
      url: substituteVars(target, fields, { keepUnresolved: true }),
      headers,
      credentialHeaders,
      templates: [...templates, ...bodyTemplates],
    },
  };
}
