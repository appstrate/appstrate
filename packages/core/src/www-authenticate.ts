// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 9110 `WWW-Authenticate` Bearer challenge parsing (RFC 6750 §3), shared by
 * the platform, the connect package and the run sidecar.
 */

import { scopeTokenSchema } from "./integration.ts";

/** Most scopes surfaced from one challenge: the header is server-controlled. */
const MAX_REQUIRED_SCOPES = 20;

/** Longest scope token kept: the scopes reach the model, and the header is server-controlled. */
const MAX_REQUIRED_SCOPE_LENGTH = 128;

/** Split the challenge list in one pass, preserving quoted commas and quoted-pairs. */
function* challengeFields(header: string) {
  let start = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (quoted && c === "\\") i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === ",") {
      yield header.slice(start, i);
      start = i + 1;
    }
  }
  if (!quoted) yield header.slice(start);
}

export interface BearerChallenge {
  resourceMetadataUrl?: string;
  scopes?: string[];
  error?: string;
}

/** The first Bearer challenge, including only its own RFC 9110 auth-params. */
export function parseBearerChallenge(header: string): BearerChallenge | undefined {
  let bearer: Map<string, string> | undefined;
  for (const part of challengeFields(header)) {
    let field = part.trim();
    if (!field) continue;
    // A leading token followed by '=' is another parameter of the current challenge.
    if (!/^[!#$%&'*+.^_`|~\w-]+\s*=/.test(field)) {
      if (bearer) break;
      const scheme = /^([^\s]+)(?:\s+([\s\S]*))?$/.exec(field);
      if (scheme?.[1]?.toLowerCase() !== "bearer") continue;
      bearer = new Map();
      field = scheme[2] ?? "";
    }
    if (!bearer) continue;
    const param =
      /^([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([!#$%&'*+.^_`|~\w-]+))$/.exec(field);
    if (param) bearer.set(param[1]!.toLowerCase(), param[2]?.replace(/\\(.)/g, "$1") ?? param[3]!);
  }
  if (!bearer) return undefined;
  const resourceMetadataUrl = bearer.get("resource_metadata");
  const scopes = bearer.get("scope")?.split(/\s+/).filter(Boolean);
  const error = bearer.get("error");
  return {
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(scopes?.length ? { scopes } : {}),
    ...(error ? { error } : {}),
  };
}

/** Keep the valid scope tokens of a server-controlled list: non-strings, invalid and over-long tokens dropped, capped. */
export function sanitiseRequiredScopes(list: readonly unknown[] | undefined): string[] {
  return (list ?? [])
    .filter(
      (s): s is string =>
        typeof s === "string" &&
        s.length <= MAX_REQUIRED_SCOPE_LENGTH &&
        scopeTokenSchema.safeParse(s).success,
    )
    .slice(0, MAX_REQUIRED_SCOPES);
}

/**
 * The scopes a server asks for when it refuses a call: only on a 401, or a 403
 * `insufficient_scope` (RFC 6750 §3.1). Tokens that are not valid scope tokens
 * and tokens over {@link MAX_REQUIRED_SCOPE_LENGTH} characters are dropped; at most
 * {@link MAX_REQUIRED_SCOPES} are kept.
 */
export function requiredScopesFromChallenge(
  status: number,
  header: string | null,
): string[] | undefined {
  if (!header || (status !== 401 && status !== 403)) return undefined;
  const challenge = parseBearerChallenge(header);
  if (status === 403 && challenge?.error !== "insufficient_scope") return undefined;
  const scopes = sanitiseRequiredScopes(challenge?.scopes);
  return scopes.length ? scopes : undefined;
}
