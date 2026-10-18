// SPDX-License-Identifier: Apache-2.0

/**
 * This instance as an OAuth client identified by a Client ID Metadata Document
 * (draft-ietf-oauth-client-id-metadata-document; MCP 2026-07-28 "Client
 * Registration"): its `client_id` is the HTTPS URL of a JSON document it serves,
 * which the authorization server fetches. Nothing is registered and nothing is
 * stored — the URL is the whole client, so it is also the connection's
 * `client_ref` (a value no system id, `^[\w.-]+$`, and no row UUID can take).
 *
 * Two kinds of document, one per redirect URI the platform sends, because the
 * server compares `redirect_uri` exactly against the document's list:
 *
 *   - `/oauth/client-metadata.json` — the shared callback, for an auth whose
 *     authorization server is the manifest's;
 *   - `/oauth/client-metadata/<base64url(issuer)>.json` — the per-server callback
 *     `<callback>/<tag>` of a server chosen per connection (AFPS §7.3). The name
 *     carries the issuer itself, not its tag, so the client resolved from the ref
 *     is bound to that server (callback `iss` check, refresh endpoint) with no
 *     row to read it from.
 */

import { getEnv } from "@appstrate/env";
import { isBlockedHost } from "@appstrate/core/ssrf";
import { integrationCallbackUrl, integrationCallbackUrlFor } from "./integration-callback-url.ts";

const CLIENT_METADATA_DOCUMENT_PATH = "/oauth/client-metadata.json";
/** Directory of the per-server documents (the router serves `/:document` under it). */
const PER_SERVER_CLIENT_METADATA_PREFIX = "/oauth/client-metadata/";
const DOCUMENT_NAME = /^([A-Za-z0-9_-]+)\.json$/;

/**
 * Whether an authorization server on the internet can fetch this instance's documents: `APP_URL`
 * is `https` (the draft requires it of a `client_id`) on a host that is not loopback or private.
 * Literal check, no DNS: a tier-0 `http://localhost:3000` is refused, as is an RFC 1918 address.
 */
export function clientMetadataDocumentsServable(): boolean {
  const url = new URL(getEnv().APP_URL);
  return url.protocol === "https:" && !isBlockedHost(url.hostname);
}

/** The `client_id` (= document URL) for `issuer`'s server chosen per connection, `null` = shared. */
export function clientMetadataDocumentUrl(issuer: string | null): string {
  const base = getEnv().APP_URL;
  return issuer === null
    ? `${base}${CLIENT_METADATA_DOCUMENT_PATH}`
    : `${base}${PER_SERVER_CLIENT_METADATA_PREFIX}${Buffer.from(issuer).toString("base64url")}.json`;
}

/** The redirect URI the document `issuer` names (and the connect flow sends with it). */
export function clientMetadataRedirectUri(issuer: string | null): string {
  return issuer === null ? integrationCallbackUrl() : integrationCallbackUrlFor(issuer);
}

/**
 * The issuer a per-server document name encodes, `undefined` when the name is not one this
 * instance would mint (not base64url, not a URL, or a non-canonical spelling of one).
 */
export function issuerOfClientMetadataDocument(name: string): string | undefined {
  const encoded = DOCUMENT_NAME.exec(name)?.[1];
  if (encoded === undefined) return undefined;
  const issuer = Buffer.from(encoded, "base64url").toString("utf8");
  if (!URL.canParse(issuer)) return undefined;
  return Buffer.from(issuer).toString("base64url") === encoded ? issuer : undefined;
}

/**
 * Which of this instance's documents a connection's `client_ref` names: `{ issuer: null }` for the
 * shared one, the bound issuer for a per-server one, `null` when the ref is no document of this
 * `APP_URL` (a system id, a row UUID — or a document of an origin the instance moved away from,
 * which no server can fetch any more).
 */
export function parseClientMetadataDocumentRef(
  clientRef: string,
): { issuer: string | null } | null {
  if (clientRef === clientMetadataDocumentUrl(null)) return { issuer: null };
  const prefix = `${getEnv().APP_URL}${PER_SERVER_CLIENT_METADATA_PREFIX}`;
  if (!clientRef.startsWith(prefix)) return null;
  const issuer = issuerOfClientMetadataDocument(clientRef.slice(prefix.length));
  return issuer === undefined ? null : { issuer };
}

/** The `client_name` this instance presents to an authorization server (CIMD and DCR alike). */
export function platformClientName(): string {
  return `Appstrate (${new URL(getEnv().APP_URL).host})`;
}

/** The wire shape of a Client ID Metadata Document (RFC 7591 §2 metadata, snake_case). */
export interface ClientMetadataDocument {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: [string];
  grant_types: string[];
  response_types: ["code"];
  token_endpoint_auth_method: "none";
}

/**
 * The document for `issuer` (`null` = shared). A public client (`none` + PKCE, the only shape the
 * auto-provisioned path drives), no secret, no `jwks`. `refresh_token` is listed unconditionally:
 * one document serves every server, and MCP asks a client wanting refresh tokens to declare the
 * grant — a server that issues none simply does not.
 */
export function clientMetadataDocument(issuer: string | null): ClientMetadataDocument {
  return {
    client_id: clientMetadataDocumentUrl(issuer),
    client_name: platformClientName(),
    client_uri: getEnv().APP_URL,
    redirect_uris: [clientMetadataRedirectUri(issuer)],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
