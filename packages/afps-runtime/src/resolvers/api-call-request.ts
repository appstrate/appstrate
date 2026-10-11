// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

/** The caller half of an `api_call`, prepared the same way by the platform proxy, the sidecar and the local CLI. */

import { InvalidHeaderValueError, isHttpFieldValue } from "@appstrate/afps-shared/delivery-http";
import {
  RequestTemplateError,
  substituteRequest,
  UnencodableInputError,
} from "./request-template.ts";
import { substituteVars, unresolvedPlaceholders } from "./template-vars.ts";

export interface PreparedApiCallRequest {
  /** Holds decrypted values: for the wire, never for a message. */
  url: string;
  headers: Record<string, string>;
  /** The call's text body, substituted; null when the call gave none to substitute. */
  body: string | null;
  /** Names of the headers a credential value went into: a hop leaving the allowlist strips them. */
  credentialHeaders: string[];
  /** Every template of the call (target, headers, body, body parts): `credentialUrlPolicy`'s input. */
  templates: string[];
}

type Prepared =
  | { ok: true; request: PreparedApiCallRequest }
  /** `message` names placeholder keys and header names, never a value. */
  | {
      ok: false;
      refusal: {
        kind: "unresolved_placeholder" | "invalid_header" | "invalid_body" | "credential_unusable";
        message: string;
      };
    };

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
 * `bodyParts` are the strings of a structured body (JSON leaves, multipart fields) the caller
 * substitutes itself, where its serializer does the encoding. Only `credential_unusable` blames a value.
 */
export function prepareApiCallRequest(call: {
  target: string;
  headers: Readonly<Record<string, string>>;
  body: string | null;
  bodyParts?: readonly string[];
  fields: Readonly<Record<string, string>>;
}): Prepared {
  const { target, fields, body, bodyParts = [] } = call;
  const missingIn = (template: string) => unresolvedPlaceholders(template, fields);

  const missingInTarget = missingIn(target);
  if (missingInTarget.length > 0) return unresolved("target", missingInTarget);

  const templates: Record<string, string> = {};
  for (const [name, written] of Object.entries(call.headers)) {
    const template = repairAuthScheme(name, written);
    if (!isHttpFieldValue(template)) {
      const { message } = new InvalidHeaderValueError(name);
      return { ok: false, refusal: { kind: "invalid_header", message } };
    }
    const missing = missingIn(template);
    if (missing.length > 0) return unresolved(`header "${name}"`, missing);
    templates[name] = template;
  }

  const missingInBody = [...(body === null ? [] : [body]), ...bodyParts].flatMap(missingIn);
  if (missingInBody.length > 0) return unresolved("body", missingInBody);

  let rendered;
  try {
    rendered = substituteRequest({ url: target, headers: templates, body }, fields);
    // A part's serializer encodes any well-formed string, and only those.
    for (const part of bodyParts) {
      substituteVars(part, fields, {
        encode: (value, key) => {
          if (value.isWellFormed()) return value;
          throw new UnencodableInputError(key, "is not well-formed Unicode");
        },
      });
    }
  } catch (err) {
    const { message } = err as Error;
    if (err instanceof UnencodableInputError) {
      return { ok: false, refusal: { kind: "credential_unusable", message } };
    }
    if (err instanceof RequestTemplateError) {
      const kind = err.part === "headers" ? "invalid_header" : "invalid_body";
      return { ok: false, refusal: { kind, message } };
    }
    throw err;
  }
  return {
    ok: true,
    request: {
      ...rendered,
      credentialHeaders: Object.keys(templates).filter(
        (name) => rendered.headers[name] !== templates[name],
      ),
      templates: [
        target,
        ...Object.values(call.headers),
        ...(body === null ? [] : [body]),
        ...bodyParts,
      ],
    },
  };
}
