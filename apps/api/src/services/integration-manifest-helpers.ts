// SPDX-License-Identifier: Apache-2.0

// Typed accessors over the AFPS integration manifest (§7), whose loose schema types fields `unknown`.

import {
  getApiCallConfigs,
  isUnauthenticatedIntegration,
  selectedApiCallConfigs,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import { isToolsWildcard } from "@appstrate/core/dependencies";
import type { IntegrationSpawnSpec, ManifestDeliveryHttp } from "@appstrate/core/sidecar-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import type { TokenEndpointAuthMethod } from "@appstrate/connect";
import { renderAuthorizedUris } from "@appstrate/afps-shared/authorized-uris";
import {
  isVariableTemplate,
  renderUrlTemplate,
  stripTrailingSlashes,
} from "@appstrate/afps-shared/connection-variables";
import { renderCredentialTemplate as renderCredentialTemplateCore } from "@appstrate/afps-shared/credential-template";

/** The sidecar's type, so the spawn resolver and the connect-login renderer cannot drift. */
export type AfpsHttpDelivery = ManifestDeliveryHttp;

export interface AfpsManifestAuth {
  type: "oauth2" | "api_key" | "basic" | "custom" | "mtls";
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  /** Narrowed by {@link toSupportedTokenEndpointAuthMethod} before any token exchange. */
  token_endpoint_auth_method?:
    | "client_secret_basic"
    | "client_secret_post"
    | "client_secret_jwt"
    | "private_key_jwt"
    | "tls_client_auth"
    | "self_signed_tls_client_auth"
    | "none";
  code_challenge_methods_supported?: string[];
  resource?: string;
  authorization_params?: Record<string, unknown>;
  default_scopes?: string[];
  identity_claims?: Record<string, string>;
  required_identity_claims?: string[];
  credentials?: { schema: Record<string, unknown> };
  connect?: AfpsManifestConnect;
  delivery: {
    http?: AfpsHttpDelivery;
    env?: Record<string, AfpsDeliveryEnvEntry>;
    files?: Record<string, AfpsDeliveryFilesEntry>;
  };
  authorized_uris?: string[];
  allow_all_uris?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * The client-auth methods the platform implements; the JWT-assertion and mTLS ones become
 * `undefined`, i.e. RFC 8414 §2's default `client_secret_basic`. Takes `string` so a value read
 * back from the `integration_oauth_clients` text column goes through the same narrowing.
 */
export function toSupportedTokenEndpointAuthMethod(
  method: AfpsManifestAuth["token_endpoint_auth_method"] | string | undefined,
): TokenEndpointAuthMethod | undefined {
  return method === "client_secret_basic" || method === "client_secret_post" || method === "none"
    ? method
    : undefined;
}

/**
 * Shared by the API (`oauthClientCreateSchema`) and env (`rawSystemIntegrationClientSchema`)
 * declarations of an OAuth client, so both refuse the same mistake in the same words. A blank
 * secret cannot tell "declared public" from "forgot the secret".
 */
export const CLIENT_SECRET_REQUIRED_MESSAGE =
  "client_secret is required and must not be empty; if the provider registered this app as a public client (no secret at all), declare it with token_endpoint_auth_method='none' instead of omitting the secret";

/** `"none"` with a secret: one of the two is a mistake, and nothing can tell which. */
export const PUBLIC_CLIENT_WITH_SECRET_MESSAGE =
  "token_endpoint_auth_method='none' declares a public client; do not send a client_secret with it";

export interface AfpsDeliveryEnvEntry {
  value: string;
  sensitive?: boolean;
  /** The mcp-server `${user_config.<key>}` this value fills (AFPS §7.6); defaults to the map key. */
  user_config_key?: string;
}
export interface AfpsDeliveryFilesEntry {
  value: string;
  mode?: string;
}

export interface AfpsManifestConnect {
  login?: {
    request: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: string;
      content_type?: string;
    };
    success_criteria?: Array<{ condition: string }>;
    outputs?: Record<string, unknown>;
    expires_in_output?: string;
    identity_outputs?: string[];
  };
  tool?: Record<string, unknown>;
  limits?: { request_timeout_ms?: number; max_response_bytes?: number };
  _meta?: Record<string, unknown>;
}

/** `connect._meta["dev.appstrate/connect"]`: the run policy AFPS leaves to the consumer. */
interface AppstrateConnectMeta {
  tool?: string;
  run_at?: "link" | "run-start";
  reauth_on?: number[];
  produces?: string[];
  persist_login_secret?: boolean;
}

const APPSTRATE_CONNECT_META_KEY = "dev.appstrate/connect";

/**
 * A `delivery.env` / `delivery.files` template rendered for one connection; `null` when it renders
 * empty, so an entry whose credential field is absent is skipped rather than injected blank.
 */
export function renderCredentialTemplate(
  template: string,
  fields: Readonly<Record<string, string>>,
  variables: Readonly<Record<string, string>>,
): string | null {
  return renderCredentialTemplateCore(template, fields, { emptyAs: "null", variables });
}

export function renderAuthAuthorizedUris(
  auth: Pick<AfpsManifestAuth, "authorized_uris">,
  fields: Readonly<Record<string, string>>,
  variables: Readonly<Record<string, string>>,
): string[] {
  return renderAuthorizedUris(auth.authorized_uris ?? [], fields, variables);
}

/** Local runner egress policy; `undefined` when the auth declares no outbound surface. */
export function runnerEgressFor(
  auth: Pick<AfpsManifestAuth, "authorized_uris" | "allow_all_uris">,
  authorizedUris: readonly string[],
): IntegrationSpawnSpec["egress"] {
  const allowAllUris = auth.allow_all_uris === true;
  if ((auth.authorized_uris?.length ?? 0) === 0 && !allowAllUris) return undefined;
  return {
    authorizedUris: [...authorizedUris],
    declaredUris: [...(auth.authorized_uris ?? [])],
    allowAllUris,
  };
}

/** AFPS §7.6 default: owner read-only, for credential material. */
export const DEFAULT_DELIVERY_FILE_MODE = "0400";

/** `"0400"`, `"400"` or `"0o400"` → `"0400"`; `null` when malformed. */
export function parseFileMode(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const body =
    trimmed.startsWith("0o") || trimmed.startsWith("0O")
      ? trimmed.slice(2)
      : trimmed.replace(/^0+/, "");
  if (body.length === 0 || body.length > 4) return null;
  if (!/^[0-7]+$/.test(body)) return null;
  return `0${body.padStart(3, "0").slice(-3)}`;
}

/** A `delivery.files` key safe to write in the runner: absolute, no NUL, no `..`, not the root. */
export function isSafeDeliveryFilePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes("\0")) return false;
  if (!path.startsWith("/")) return false;
  // Refused even when it would not escape: in a declared path a `..` is always a mistake.
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "..") return false;
  }
  const meaningful = segments.filter((s) => s.length > 0 && s !== ".");
  if (meaningful.length === 0) return false;
  return true;
}

export function getIntegrationSourceKind(
  manifest: IntegrationManifest,
): "local" | "remote" | "none" | undefined {
  const source = (manifest as { source?: { kind?: string } }).source;
  const kind = source?.kind;
  return kind === "local" || kind === "remote" || kind === "none" ? kind : undefined;
}

/**
 * Auths whose connection exposes a tool of `selection` — a server's own tools via any auth, an
 * `api_call` only via its own. `null` when every auth does, or none does (not a connection
 * problem).
 */
export function authKeysServingSelection(
  manifest: IntegrationManifest,
  selection: readonly string[] | "*" | undefined,
): ReadonlySet<string> | null {
  if (selection === undefined || selection.length === 0) return null;
  const kind = getIntegrationSourceKind(manifest);
  if (kind === "local" || kind === "remote") {
    if (isToolsWildcard(selection)) return null;
    const apiCallNames = new Set(
      getApiCallConfigs(manifest).flatMap((cfg) =>
        cfg.uploadToolName ? [cfg.toolName, cfg.uploadToolName] : [cfg.toolName],
      ),
    );
    if (selection.some((name) => !apiCallNames.has(name))) return null;
  }
  const serving = new Set(selectedApiCallConfigs(manifest, selection).map((cfg) => cfg.authKey));
  return serving.size === 0 ? null : serving;
}

/**
 * The dep's `auth_key` (AFPS §4.1) when it names a declared auth serving none of `selection` —
 * no connection can satisfy it — with the auths that do; else `null`.
 */
export function authKeyServingNoSelectedTool(
  manifest: IntegrationManifest,
  authKey: string | undefined,
  selection: readonly string[] | "*" | undefined,
): { authKey: string; servingAuthKeys: string[] } | null {
  if (authKey === undefined || !manifest.auths?.[authKey]) return null;
  const serving = authKeysServingSelection(manifest, selection);
  if (serving === null || serving.has(authKey)) return null;
  return { authKey, servingAuthKeys: [...serving] };
}

/**
 * AFPS §4.4 MUST: an `auth_key` naming an auth of an unauthenticated integration (§7.2), which
 * has none. Judged before every short-circuit: an integration can lose its `auths` after the
 * agent was saved, so the write gate alone cannot hold it.
 */
export function authKeyOnUnauthenticatedIntegration(
  manifest: IntegrationManifest,
  authKey: string | undefined,
): authKey is string {
  return authKey !== undefined && isUnauthenticatedIntegration(manifest);
}

export function getLocalServerRef(
  manifest: IntegrationManifest,
): { name: string; version: string } | null {
  const source = (
    manifest as { source?: { kind?: string; server?: { name?: unknown; version?: unknown } } }
  ).source;
  if (source?.kind !== "local" || !source.server) return null;
  const { name, version } = source.server;
  if (typeof name !== "string" || typeof version !== "string") return null;
  return { name, version };
}

/**
 * `transport` is checked against AFPS §7.1's enum so no caller is tempted to coerce an unknown one
 * to HTTP. The schema parse already refuses it; this keeps the type honest, it is not the gate.
 */
export function getRemoteSource(
  manifest: IntegrationManifest,
): { url: string; transport: "streamable-http" | "sse" } | null {
  const source = (
    manifest as { source?: { kind?: string; remote?: { url?: unknown; transport?: unknown } } }
  ).source;
  if (source?.kind !== "remote" || !source.remote) return null;
  const { url, transport } = source.remote;
  if (typeof url !== "string") return null;
  if (transport !== "streamable-http" && transport !== "sse") return null;
  return { url, transport };
}

/** `source.remote` rendered for one connection (AFPS §7.12); `null` when absent or unrenderable. */
export function renderRemoteSource(
  manifest: IntegrationManifest,
  variables: Readonly<Record<string, string>> | null,
): { url: string; transport: "streamable-http" | "sse" } | null {
  const remote = getRemoteSource(manifest);
  if (!remote) return null;
  const url = renderUrlTemplate(remote.url, variables ?? {});
  return url === null ? null : { url, transport: remote.transport };
}

export function getVariablesSchema(manifest: IntegrationManifest): JSONSchemaObject | null {
  const schema = (manifest as { variables?: { schema?: unknown } }).variables?.schema;
  return typeof schema === "object" && schema !== null && !Array.isArray(schema)
    ? (schema as JSONSchemaObject)
    : null;
}

/**
 * Whether `issuer` is the authorization server an oauth2 auth's manifest fixes: its declared
 * `issuer`, else an issuer of its remote URL's origin; none when chosen per connection.
 */
export function isFixedAuthorizationServer(
  issuer: string,
  manifest: IntegrationManifest,
  auth: Pick<AfpsManifestAuth, "type" | "issuer">,
): boolean {
  if (hasPerConnectionAuthServer(manifest, auth)) return false;
  if (auth.issuer) return stripTrailingSlashes(auth.issuer) === stripTrailingSlashes(issuer);
  const remoteUrl = getRemoteSource(manifest)?.url;
  return (
    remoteUrl !== undefined &&
    URL.canParse(issuer) &&
    URL.canParse(remoteUrl) &&
    new URL(issuer).origin === new URL(remoteUrl).origin
  );
}

/** Whether an oauth2 auth's server is chosen per connection (AFPS §7.3): a templated issuer or URL. */
export function hasPerConnectionAuthServer(
  manifest: IntegrationManifest,
  auth: Pick<AfpsManifestAuth, "type" | "issuer">,
): boolean {
  if (auth.type !== "oauth2") return false;
  return isVariableTemplate(auth.issuer) || isVariableTemplate(getRemoteSource(manifest)?.url);
}

/**
 * A client provisioned at connect time is public (`none` + PKCE), so a remote auth declaring a
 * confidential method stays admin-registered; whether its server accepts either is checked at run.
 */
export function usesAutoProvisionedClient(
  manifest: IntegrationManifest,
  auth: AfpsManifestAuth,
): boolean {
  return (
    auth.type === "oauth2" &&
    auth.token_endpoint_auth_method === "none" &&
    (getRemoteSource(manifest) !== null || hasPerConnectionAuthServer(manifest, auth))
  );
}

export function getAppstrateConnectMeta(
  connect: AfpsManifestConnect | undefined,
): AppstrateConnectMeta | undefined {
  const meta = connect?._meta?.[APPSTRATE_CONNECT_META_KEY];
  return meta && typeof meta === "object" ? (meta as AppstrateConnectMeta) : undefined;
}
