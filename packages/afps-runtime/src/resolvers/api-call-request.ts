// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

/** The caller half of an `api_call`, prepared the same way by the platform proxy, the sidecar and the local CLI. */

import { InvalidHeaderValueError, isHttpFieldValue } from "@appstrate/afps-shared/delivery-http";
import type { PREPARE_REFUSAL_CODE } from "./api-call-failure-codes.ts";
import { substituteVars, unresolvedPlaceholders } from "./template-vars.ts";

export interface PreparedApiCallRequest {
  /** Holds decrypted values: for the wire, never for a message. */
  url: string;
  headers: Record<string, string>;
  /** Names of the headers a credential value went into: a hop leaving the allowlist strips them. */
  credentialHeaders: string[];
  /** Every template of the call (target, headers, body): `credentialUrlPolicy`'s input. */
  templates: string[];
}

type Prepared =
  | { ok: true; request: PreparedApiCallRequest }
  /** `message` names placeholder keys and header names, never a value. */
  | { ok: false; refusal: { kind: keyof typeof PREPARE_REFUSAL_CODE; message: string } };

function unresolved(where: string, keys: readonly string[]): Prepared {
  return {
    ok: false,
    refusal: {
      kind: "unresolved_placeholder",
      message: `Unresolved placeholders in ${where}: {{${[...new Set(keys)].join(",")}}}`,
    },
  };
}

/**
 * `Bearer{{token}}` → `Bearer {{token}}`: an LLM sometimes drops the space. On the TEMPLATE only: on
 * a resolved value it would split a secret starting with a scheme name (`tokenlive_sk_123`, #988).
 */
function repairAuthScheme(headerName: string, template: string): string {
  if (headerName.toLowerCase() !== "authorization") return template;
  return template.replace(/^(Bearer|Basic|Token)(?=\{\{)/i, "$1 ");
}

/**
 * Substitute `fields` into the target and the caller's headers, or refuse on the first defect: the
 * target, then each header (value invalid as written, then an unresolved placeholder), then
 * `bodyTemplates`, the strings the caller's own body substitution reads.
 */
export function prepareApiCallRequest(call: {
  target: string;
  headers: Readonly<Record<string, string>>;
  bodyTemplates: readonly string[];
  fields: Readonly<Record<string, string>>;
}): Prepared {
  const { target, fields, bodyTemplates } = call;
  const missingIn = (template: string) => unresolvedPlaceholders(template, fields);

  const missingInTarget = missingIn(target);
  if (missingInTarget.length > 0) return unresolved("target", missingInTarget);

  const headers: Record<string, string> = {};
  const credentialHeaders: string[] = [];
  for (const [name, written] of Object.entries(call.headers)) {
    const template = repairAuthScheme(name, written);
    if (!isHttpFieldValue(template)) {
      const { message } = new InvalidHeaderValueError(name);
      return { ok: false, refusal: { kind: "invalid_header", message } };
    }
    const missing = missingIn(template);
    if (missing.length > 0) return unresolved(`header "${name}"`, missing);
    headers[name] = substituteVars(template, fields, { keepUnresolved: true });
    if (headers[name] !== template) credentialHeaders.push(name);
  }

  const missingInBody = bodyTemplates.flatMap(missingIn);
  if (missingInBody.length > 0) return unresolved("body", missingInBody);

  return {
    ok: true,
    request: {
      url: substituteVars(target, fields, { keepUnresolved: true }),
      headers,
      credentialHeaders,
      templates: [target, ...Object.values(call.headers), ...bodyTemplates],
    },
  };
}
