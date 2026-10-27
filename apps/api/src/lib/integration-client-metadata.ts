// SPDX-License-Identifier: Apache-2.0

/**
 * Client ID Metadata Documents (MCP 2026-07-28): the `client_id`, and the connection's `client_ref`,
 * is the URL of a document served per authorization server, its name binding the issuer. Mix-up
 * (RFC 9700 §4.4): presented only to a server sending RFC 9207 `iss`, on a redirect URI
 * (`<callback>/cimd/<tag>`) no DCR client registers.
 */

import { getEnv } from "@appstrate/env";
import { isBlockedHost } from "@appstrate/core/ssrf";
import { isAllowedInternalIdpHost } from "@appstrate/connect";
import { clientMetadataCallbackUrlFor } from "./integration-callback-url.ts";

const CLIENT_METADATA_PREFIX = "/oauth/client-metadata/";
const DOCUMENT_NAME = /^([A-Za-z0-9_-]+)\.json$/;
const MAX_DOCUMENT_NAME_LENGTH = 2048;

/** Literal check, no DNS: an internal hostname passes, which `INTEGRATION_OAUTH_CIMD=off` is for. */
function clientMetadataDocumentsServable(): boolean {
  const env = getEnv();
  if (env.INTEGRATION_OAUTH_CIMD === "off") return false;
  const url = new URL(env.APP_URL);
  return url.protocol === "https:" && !isBlockedHost(url.hostname);
}

/** Only an issuer whose document the route serves ({@link isDocumentIssuer}). */
export function presentsClientMetadataDocument(metadata: {
  issuer?: string;
  clientIdMetadataDocumentSupported?: boolean;
  authorizationResponseIssParameterSupported?: boolean;
}): metadata is { issuer: string; clientIdMetadataDocumentSupported: true } {
  return (
    metadata.clientIdMetadataDocumentSupported === true &&
    metadata.authorizationResponseIssParameterSupported === true &&
    metadata.issuer !== undefined &&
    clientMetadataDocumentsServable() &&
    isDocumentIssuer(metadata.issuer)
  );
}

export type ProvisionabilityProblem =
  "authorization_server_pkce_unsupported" | "authorization_server_iss_unsupported";

/**
 * What a server's validated metadata lacks for a client this platform provisions, in refusal order:
 * PKCE S256 on an MCP server, RFC 9207 `iss` unless the platform vouches for it (RFC 9700 §4.4.2.2).
 */
export function provisionabilityProblems(
  metadata: {
    codeChallengeMethodsSupported?: string[];
    authorizationResponseIssParameterSupported?: boolean;
  },
  policy: { mcp: boolean; vouched: boolean },
): ProvisionabilityProblem[] {
  const problems: ProvisionabilityProblem[] = [];
  if (policy.mcp && !metadata.codeChallengeMethodsSupported?.includes("S256")) {
    problems.push("authorization_server_pkce_unsupported");
  }
  if (!policy.vouched && metadata.authorizationResponseIssParameterSupported !== true) {
    problems.push("authorization_server_iss_unsupported");
  }
  return problems;
}

const documentName = (issuer: string) => `${Buffer.from(issuer).toString("base64url")}.json`;

export function clientMetadataDocumentUrl(issuer: string): string {
  return `${getEnv().APP_URL}${CLIENT_METADATA_PREFIX}${documentName(issuer)}`;
}

/** Plain `http` only on a host of `EGRESS_ALLOW_INTERNAL_HOSTS`, the one case connect reaches it. */
function isDocumentIssuer(issuer: string): boolean {
  if (documentName(issuer).length > MAX_DOCUMENT_NAME_LENGTH || !URL.canParse(issuer)) {
    return false;
  }
  const url = new URL(issuer);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && isAllowedInternalIdpHost(url.hostname))
  );
}

/** `undefined` unless this instance would mint that name. */
export function issuerOfClientMetadataDocument(name: string): string | undefined {
  if (name.length > MAX_DOCUMENT_NAME_LENGTH) return undefined;
  const encoded = DOCUMENT_NAME.exec(name)?.[1];
  if (encoded === undefined) return undefined;
  const issuer = Buffer.from(encoded, "base64url").toString("utf8");
  if (!isDocumentIssuer(issuer)) return undefined;
  return documentName(issuer) === name ? issuer : undefined;
}

/** `null` for a system id, a row UUID, or a document of an `APP_URL` the instance moved away from. */
export function issuerOfClientMetadataDocumentRef(clientRef: string): string | null {
  const prefix = `${getEnv().APP_URL}${CLIENT_METADATA_PREFIX}`;
  if (!clientRef.startsWith(prefix)) return null;
  return issuerOfClientMetadataDocument(clientRef.slice(prefix.length)) ?? null;
}

/** CIMD and DCR alike. */
export function platformClientName(): string {
  return `Appstrate (${new URL(getEnv().APP_URL).host})`;
}

export interface ClientMetadataDocument {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: [string];
  grant_types: string[];
  response_types: ["code"];
  token_endpoint_auth_method: "none";
}

/** `refresh_token` always listed: MCP asks a client wanting refresh tokens to declare the grant. */
export function clientMetadataDocument(issuer: string): ClientMetadataDocument {
  return {
    client_id: clientMetadataDocumentUrl(issuer),
    client_name: platformClientName(),
    client_uri: getEnv().APP_URL,
    redirect_uris: [clientMetadataCallbackUrlFor(issuer)],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
