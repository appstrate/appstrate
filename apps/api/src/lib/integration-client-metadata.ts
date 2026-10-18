// SPDX-License-Identifier: Apache-2.0

/**
 * This instance as an OAuth client identified by a Client ID Metadata Document
 * (draft-ietf-oauth-client-id-metadata-document; MCP 2026-07-28 "Client
 * Registration"): its `client_id` is the HTTPS URL of a JSON document it serves,
 * which the authorization server fetches. Nothing is registered and nothing is
 * stored — the URL is the whole client, so it is also the connection's
 * `client_ref` (a value no system id, `^[\w.-]+$`, and no row UUID can take).
 *
 * One document per authorization server, never a shared one:
 * `/oauth/client-metadata/<base64url(issuer)>.json`, listing that server's own
 * redirect URI `<callback>/cimd/<tag>` (`clientMetadataCallbackUrlFor`). The
 * name carries the issuer itself, not its tag, so the client resolved from the
 * ref is bound to that server (callback `iss` check, refresh endpoint) with no
 * row to read it from.
 *
 * Mix-up (RFC 9700 §4.4): any server fetches any document, so a hostile server
 * A can bounce the user to an honest server B with A's document as `client_id`
 * and its redirect URI — B reads the document, accepts both, and returns the
 * code to A's redirect URI, after which the code and the PKCE verifier would
 * go to A's token endpoint. Two rules close it:
 *
 *   - a document is presented only to a server advertising RFC 9207 `iss`, and
 *     the OAuth state of a document client requires an `iss` equal to its
 *     issuer — B's response, its own `iss` or none, is refused;
 *   - the document's redirect URI is in a namespace DCR never registers
 *     (`/callback/cimd/<tag>`, not `/callback/<tag>`), so a response there can
 *     only satisfy a document client's state — never the state of a DCR client
 *     of a server without `iss` whose tag is the same.
 */

import { getEnv } from "@appstrate/env";
import { isBlockedHost } from "@appstrate/core/ssrf";
import { isAllowedInternalIdpHost } from "@appstrate/connect";
import { clientMetadataCallbackUrlFor } from "./integration-callback-url.ts";

const CLIENT_METADATA_PREFIX = "/oauth/client-metadata/";
const DOCUMENT_NAME = /^([A-Za-z0-9_-]+)\.json$/;
/** Longest document name served: a bound on the decode, far above any real issuer. */
const MAX_DOCUMENT_NAME_LENGTH = 2048;

/**
 * Whether connect may present a metadata document: the operator has not switched it off
 * (`INTEGRATION_OAUTH_CIMD=off`), and an authorization server on the internet can fetch it —
 * `APP_URL` is `https` (the draft requires it of a `client_id`) on a host that is not loopback or
 * private. Literal check, no DNS: a tier-0 `http://localhost:3000` is refused, as is an RFC 1918
 * address; an internal hostname is not, which is what the switch is for.
 */
function clientMetadataDocumentsServable(): boolean {
  const env = getEnv();
  if (env.INTEGRATION_OAUTH_CIMD === "off") return false;
  const url = new URL(env.APP_URL);
  return url.protocol === "https:" && !isBlockedHost(url.hostname);
}

/**
 * Whether connect presents a metadata document to the server whose validated RFC 8414 metadata is
 * `metadata`: it advertises `client_id_metadata_document_supported` AND RFC 9207
 * `authorization_response_iss_parameter_supported` (the mix-up defence, see above), the instance
 * can serve documents ({@link clientMetadataDocumentsServable}), and its `issuer` is one a document
 * may name — the very document {@link issuerOfClientMetadataDocument} serves and resolves back.
 */
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

/** The `client_id` (= document URL) this instance presents to `issuer`'s server. */
export function clientMetadataDocumentUrl(issuer: string): string {
  return `${getEnv().APP_URL}${CLIENT_METADATA_PREFIX}${Buffer.from(issuer).toString("base64url")}.json`;
}

/**
 * Whether `issuer` may name a document: `https`, or plain `http` for a host the operator listed in
 * `EGRESS_ALLOW_INTERNAL_HOSTS` — the one case connect reaches an `http` server at all.
 */
function isDocumentIssuer(issuer: string): boolean {
  if (!URL.canParse(issuer)) return false;
  const url = new URL(issuer);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && isAllowedInternalIdpHost(url.hostname))
  );
}

/**
 * The issuer a document name encodes, `undefined` when the name is not one this instance would
 * mint (too long, not base64url, not an admissible issuer URL, or a non-canonical spelling of one).
 */
export function issuerOfClientMetadataDocument(name: string): string | undefined {
  if (name.length > MAX_DOCUMENT_NAME_LENGTH) return undefined;
  const encoded = DOCUMENT_NAME.exec(name)?.[1];
  if (encoded === undefined) return undefined;
  const issuer = Buffer.from(encoded, "base64url").toString("utf8");
  if (!isDocumentIssuer(issuer)) return undefined;
  return Buffer.from(issuer).toString("base64url") === encoded ? issuer : undefined;
}

/**
 * The issuer a connection's `client_ref` binds when it is one of this instance's documents, `null`
 * when it is none of them (a system id, a row UUID — or a document of an origin the instance moved
 * away from, which no server can fetch any more).
 */
export function issuerOfClientMetadataDocumentRef(clientRef: string): string | null {
  const prefix = `${getEnv().APP_URL}${CLIENT_METADATA_PREFIX}`;
  if (!clientRef.startsWith(prefix)) return null;
  return issuerOfClientMetadataDocument(clientRef.slice(prefix.length)) ?? null;
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
 * The document of `issuer`'s server. A public client (`none` + PKCE, the only shape the
 * auto-provisioned path drives), no secret, no `jwks`. `refresh_token` is listed unconditionally:
 * MCP asks a client wanting refresh tokens to declare the grant — a server that issues none
 * simply does not.
 */
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
