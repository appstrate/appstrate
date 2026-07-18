// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS integration-manifest accessors.
 *
 * The AFPS integration manifest type (`@afps-spec/schema`) is built on
 * `z.looseObject`, so most fields surface as `unknown` / index-signature at the
 * TypeScript level. These helpers narrow the specific subset the platform reads
 * on the spawn / credential / connect paths — the `source` discriminant, the
 * per-auth OAuth + delivery + connect blocks, and the Appstrate `_meta`
 * extensions — into typed accessors so call sites stay readable and the snake_case
 * vocabulary lives in exactly one place.
 *
 * Vocabulary (AFPS §7):
 *   - `source.kind: "local" | "remote" | "none"`.
 *   - per-auth OAuth: `authorization_endpoint`, `token_endpoint`, `resource`,
 *     `default_scopes`, `code_challenge_methods_supported`, …
 *   - `delivery.http` is `{ in, name, prefix?, value, encoding?, allow_server_override? }`.
 *   - `connect.login` declarative, `connect.tool: {}` orchestrated; the Appstrate
 *     orchestrated-tool fields live under `connect._meta["dev.appstrate/connect"]`.
 *   - URI restrictions: `authorized_uris`, `allow_all_uris`.
 */

import type { IntegrationManifest } from "@appstrate/core/integration";
import type { ManifestDeliveryHttp } from "@appstrate/core/sidecar-types";
import { renderCredentialTemplate as renderCredentialTemplateCore } from "@appstrate/core/credential-template";

/**
 * AFPS `delivery.http` block (snake_case). The sidecar's canonical
 * {@link ManifestDeliveryHttp} type (`{ in, name, prefix?, value, encoding?,
 * allow_server_override? }`) is the source of truth so the spawn-side resolver
 * and the sidecar's connect-login renderer can never drift.
 */
export type AfpsHttpDelivery = ManifestDeliveryHttp;

/** Narrowed view of a single `auths.{key}` method (AFPS §7.2 – §7.9). */
export interface AfpsManifestAuth {
  /**
   * Auth-method type discriminant (AFPS §7.2).
   *  - `oauth2` / `api_key` / `basic` / `custom`: the base set.
   *  - `mtls`: mutual TLS client authentication. The client certificate +
   *    private key (and optional chain) are described by `credentials.schema` (§7.5)
   *    and injected via `delivery.files` (§7.6) at well-known paths the underlying
   *    HTTP client loads. Maps to OpenAPI `mutualTLS` (§7.11).
   */
  type: "oauth2" | "api_key" | "basic" | "custom" | "mtls";
  // OAuth2 (§7.3)
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  /**
   * OAuth2 token-endpoint client-auth method (§7.3). AFPS 0.1 widened this to
   * the full RFC 7591 / OIDC Core vocabulary. Appstrate's OAuth client only
   * implements `client_secret_basic` / `client_secret_post` / `none`; the
   * JWT-assertion (`client_secret_jwt`, `private_key_jwt`) and mTLS
   * (`tls_client_auth`, `self_signed_tls_client_auth`) methods are accepted in
   * the manifest type but normalized away at the token-exchange boundary
   * (treated as unspecified → RFC 8414 §2 default `client_secret_basic`).
   */
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
  // Scopes (§7.4)
  default_scopes?: string[];
  identity_claims?: Record<string, string>;
  required_identity_claims?: string[];
  // Credentials (§7.5)
  credentials?: { schema: Record<string, unknown> };
  // Connect (§7.7)
  connect?: AfpsManifestConnect;
  // Delivery (§7.6) — REQUIRED by the AFPS schema (every auth declares ≥1 channel).
  delivery: {
    http?: AfpsHttpDelivery;
    env?: Record<string, AfpsDeliveryEnvEntry>;
    files?: Record<string, AfpsDeliveryFilesEntry>;
  };
  // URI restrictions (§7.9)
  authorized_uris?: string[];
  allow_all_uris?: boolean;
  _meta?: Record<string, unknown>;
}

/** The `token_endpoint_auth_method` values Appstrate's OAuth client implements. */
export type SupportedTokenEndpointAuthMethod =
  "client_secret_basic" | "client_secret_post" | "none";

/**
 * Narrow an AFPS 0.1 `token_endpoint_auth_method` to the subset Appstrate
 * implements. The JWT-assertion / mTLS client-auth methods are valid in a 0.1
 * manifest but unsupported here — they normalize to `undefined`, which the
 * token-exchange path treats as unspecified (RFC 8414 §2 default
 * `client_secret_basic`).
 */
export function toSupportedTokenEndpointAuthMethod(
  method: AfpsManifestAuth["token_endpoint_auth_method"],
): SupportedTokenEndpointAuthMethod | undefined {
  return method === "client_secret_basic" || method === "client_secret_post" || method === "none"
    ? method
    : undefined;
}

export interface AfpsDeliveryEnvEntry {
  value: string;
  sensitive?: boolean;
  /**
   * AFPS §7.6 — when this `delivery.env` entry's value flows into the
   * referenced mcp-server's `${user_config.<key>}` placeholder (in
   * `server.mcp_config.env`). The resolver pre-renders the substitution so the
   * same integration package works in both Appstrate's local-source path AND a
   * standalone MCPB host. When omitted, consumers default to the env-variable
   * name itself (the map key).
   */
  user_config_key?: string;
}
export interface AfpsDeliveryFilesEntry {
  /**
   * Value template rendered against the credential bag — same grammar as
   * `delivery.env` (`{$credential.<field>}`). The rendered bytes are
   * materialised as the file's contents.
   */
  value: string;
  /**
   * POSIX permission bits as an octal string (e.g. `"0400"`, `"0600"`).
   * Defaults to `"0400"` (read-only owner) per AFPS §7.6.
   */
  mode?: string;
}

/** A connect block: declarative `login` OR orchestrated `tool: {}` (§7.7). */
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

/**
 * Appstrate orchestrated-tool extension carried under
 * `connect._meta["dev.appstrate/connect"]` — the run-policy fields AFPS
 * leaves to the consumer (`tool` name, `run_at`, `reauth_on`, `produces`,
 * `persist_login_secret`).
 */
export interface AppstrateConnectMeta {
  tool?: string;
  run_at?: "link" | "run-start";
  reauth_on?: number[];
  produces?: string[];
  persist_login_secret?: boolean;
}

const APPSTRATE_CONNECT_META_KEY = "dev.appstrate/connect";

/**
 * Render an AFPS `{$credential.<field>}` value template (used by
 * `delivery.env` / `delivery.files`) against a decrypted credential bag.
 * Unknown refs render empty — a missing field means "nothing to inject".
 * Returns `null` when the template resolves to an empty string (so callers can
 * skip env vars / files whose backing credential field is absent), mirroring
 * the old `delivery.env.from` "field missing → skip" behaviour.
 *
 * Thin wrapper over the shared `@appstrate/core/credential-template` renderer
 * (single implementation of the `{$credential.<field>}` syntax) pinned to the
 * `delivery.env` / `delivery.files` empty→null policy.
 */
export function renderCredentialTemplate(
  template: string,
  fields: Readonly<Record<string, string>>,
): string | null {
  return renderCredentialTemplateCore(template, fields, { emptyAs: "null" });
}

/**
 * Default file mode for `delivery.files` entries (AFPS §7.6: `"0400"`).
 * Read-only by owner — the strictest sane default for credential material.
 */
export const DEFAULT_DELIVERY_FILE_MODE = "0400";

/**
 * Parse a `delivery.files.<path>.mode` octal-string into a normalized
 * lowercase form (`"0400"`). Returns `null` for malformed input — callers
 * should fall back to {@link DEFAULT_DELIVERY_FILE_MODE} in that case.
 *
 * Accepted forms: `"0400"`, `"400"`, `"0o400"`. POSIX permissions only —
 * we reject values that don't fit `[0-7]{3,4}` after stripping an optional
 * `0o`/`0` prefix.
 */
export function parseFileMode(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Strip optional `0o` prefix; otherwise treat a leading `0` as the octal
  // prefix convention (`"0400"`).
  const body =
    trimmed.startsWith("0o") || trimmed.startsWith("0O")
      ? trimmed.slice(2)
      : trimmed.replace(/^0+/, "");
  if (body.length === 0 || body.length > 4) return null;
  if (!/^[0-7]+$/.test(body)) return null;
  // Re-pad to 4 chars with leading zero (POSIX convention).
  return `0${body.padStart(3, "0").slice(-3)}`;
}

/**
 * Validate a `delivery.files.<path>` key: must be an absolute POSIX path
 * (`/run/creds/token`), MUST NOT contain `..` segments, and MUST NOT contain
 * NUL bytes. Returns `true` when safe to materialise inside the runner's
 * filesystem.
 *
 * Rejection criteria (any one → invalid):
 *   - relative path (no leading `/`)
 *   - empty / whitespace-only
 *   - contains `..` segment after normalisation
 *   - contains NUL byte
 *   - path collapses to `/` (we won't overwrite the root)
 */
export function isSafeDeliveryFilePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes("\0")) return false;
  if (!path.startsWith("/")) return false;
  // Normalise: split on `/`, reject any `..` segment. We don't allow them
  // even if they don't escape because the manifest can declare paths
  // directly; a `..` is always operator error.
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "..") return false;
  }
  // Reject pure-root.
  const meaningful = segments.filter((s) => s.length > 0 && s !== ".");
  if (meaningful.length === 0) return false;
  return true;
}

/** The integration source discriminant kind (`local` | `remote` | `none`). */
export function getIntegrationSourceKind(
  manifest: IntegrationManifest,
): "local" | "remote" | "none" | undefined {
  const source = (manifest as { source?: { kind?: string } }).source;
  const kind = source?.kind;
  return kind === "local" || kind === "remote" || kind === "none" ? kind : undefined;
}

/** `source.server` reference for a `local`-source integration (the mcp-server package). */
export function getLocalServerRef(
  manifest: IntegrationManifest,
): { name: string; version: string; vendored?: boolean } | null {
  const source = (
    manifest as {
      source?: {
        kind?: string;
        server?: { name?: unknown; version?: unknown; vendored?: unknown };
      };
    }
  ).source;
  if (source?.kind !== "local" || !source.server) return null;
  const { name, version, vendored } = source.server;
  if (typeof name !== "string" || typeof version !== "string") return null;
  // AFPS §7.1 — `source.server.vendored` is an optional boolean build-provenance
  // signal: `true` means the referenced mcp-server's source is vendored into
  // the integration's own bundle (audit + reproducibility). Forwarded verbatim
  // through `IntegrationSpawnSpec.manifest.server.vendored` and surfaced on the
  // sidecar's boot report so operators can audit "this run used a vendored
  // foreign package".
  return typeof vendored === "boolean" ? { name, version, vendored } : { name, version };
}

/** `source.remote` for a `remote`-source integration (`{ url, transport }`). */
export function getRemoteSource(
  manifest: IntegrationManifest,
): { url: string; transport: string } | null {
  const source = (
    manifest as { source?: { kind?: string; remote?: { url?: unknown; transport?: unknown } } }
  ).source;
  if (source?.kind !== "remote" || !source.remote) return null;
  const { url, transport } = source.remote;
  if (typeof url !== "string" || typeof transport !== "string") return null;
  return { url, transport };
}

/** Read the Appstrate orchestrated-tool extension off a connect block. */
export function getAppstrateConnectMeta(
  connect: AfpsManifestConnect | undefined,
): AppstrateConnectMeta | undefined {
  const meta = connect?._meta?.[APPSTRATE_CONNECT_META_KEY];
  return meta && typeof meta === "object" ? (meta as AppstrateConnectMeta) : undefined;
}
