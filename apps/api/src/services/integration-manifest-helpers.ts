// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS 2.0 integration-manifest accessors.
 *
 * The AFPS 2.0 integration manifest type (`@afps-spec/schema`) is built on
 * `z.looseObject`, so most fields surface as `unknown` / index-signature at the
 * TypeScript level. These helpers narrow the specific subset the platform reads
 * on the spawn / credential / connect paths — the `source` discriminant, the
 * per-auth OAuth + delivery + connect blocks, and the Appstrate `_meta`
 * extensions — into typed accessors so call sites stay readable and the snake_case
 * vocabulary lives in exactly one place.
 *
 * Vocabulary (AFPS 2.0 §7, Appendix D):
 *   - `source.kind: "local" | "remote" | "api"` replaces the 1.x inline `server`.
 *   - per-auth OAuth: `authorization_endpoint`, `token_endpoint`, `resource`,
 *     `default_scopes`, `code_challenge_methods_supported`, …
 *   - `delivery.http` is `{ in, name, prefix?, value, encoding?, allow_server_override? }`.
 *   - `connect.login` declarative, `connect.tool: {}` orchestrated; the Appstrate
 *     orchestrated-tool fields live under `connect._meta["dev.appstrate/connect"]`.
 *   - URI restrictions: `authorized_uris`, `allow_all_uris`.
 */

import type { IntegrationManifest } from "@appstrate/core/integration";
import type { ManifestDeliveryHttp } from "@appstrate/core/sidecar-types";

/**
 * AFPS 2.0 `delivery.http` block (snake_case). The sidecar's canonical
 * {@link ManifestDeliveryHttp} type (`{ in, name, prefix?, value, encoding?,
 * allow_server_override? }`) is the source of truth so the spawn-side resolver
 * and the sidecar's connect-login renderer can never drift.
 */
export type AfpsHttpDelivery = ManifestDeliveryHttp;

/** Narrowed view of a single `auths.{key}` method (AFPS 2.0 §7.2 – §7.9). */
export interface AfpsManifestAuth {
  type: "oauth2" | "api_key" | "basic" | "custom";
  // OAuth2 (§7.3)
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_method?: "client_secret_post" | "client_secret_basic" | "none";
  code_challenge_methods_supported?: string[];
  resource?: string;
  authorization_params?: Record<string, unknown>;
  // Scopes (§7.4)
  default_scopes?: string[];
  identity_claims?: Record<string, string>;
  // Credentials (§7.5)
  credentials?: { schema: Record<string, unknown> };
  // Connect (§7.7)
  connect?: AfpsManifestConnect;
  // Delivery (§7.6) — REQUIRED by the AFPS schema (every auth declares ≥1 channel).
  delivery: {
    http?: AfpsHttpDelivery;
    env?: Record<string, AfpsDeliveryEnvEntry>;
    files?: Record<string, AfpsDeliveryFileEntry>;
  };
  // URI restrictions (§7.9)
  authorized_uris?: string[];
  allow_all_uris?: boolean;
  _meta?: Record<string, unknown>;
}

export interface AfpsDeliveryEnvEntry {
  value: string;
  sensitive?: boolean;
}
export interface AfpsDeliveryFileEntry {
  value: string;
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
 * `connect._meta["dev.appstrate/connect"]` — the run-policy fields AFPS 2.0
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

const CREDENTIAL_REF = /\{\$credential\.([A-Za-z0-9_]+)\}/g;

/**
 * Render an AFPS 2.0 `{$credential.<field>}` value template (used by
 * `delivery.env` / `delivery.files`) against a decrypted credential bag.
 * Unknown refs render empty — a missing field means "nothing to inject".
 * Returns `null` when the template resolves to an empty string (so callers can
 * skip env vars / files whose backing credential field is absent), mirroring
 * the old `delivery.env.from` "field missing → skip" behaviour.
 */
export function renderCredentialTemplate(
  template: string,
  fields: Readonly<Record<string, string>>,
): string | null {
  const rendered = template.replace(CREDENTIAL_REF, (_m, field: string) => fields[field] ?? "");
  return rendered.length === 0 ? null : rendered;
}

/** The integration source discriminant kind (`local` | `remote` | `api`). */
export function getIntegrationSourceKind(
  manifest: IntegrationManifest,
): "local" | "remote" | "api" | undefined {
  const source = (manifest as { source?: { kind?: string } }).source;
  const kind = source?.kind;
  return kind === "local" || kind === "remote" || kind === "api" ? kind : undefined;
}

/** `source.server` reference for a `local`-source integration (the mcp-server package). */
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

/** Narrow a manifest's `auths.{key}` to the typed accessor view. */
export function getManifestAuth(
  manifest: IntegrationManifest,
  authKey: string,
): AfpsManifestAuth | undefined {
  const auths = (manifest as { auths?: Record<string, unknown> }).auths;
  const auth = auths?.[authKey];
  return auth ? (auth as unknown as AfpsManifestAuth) : undefined;
}

/** Read the Appstrate orchestrated-tool extension off a connect block. */
export function getAppstrateConnectMeta(
  connect: AfpsManifestConnect | undefined,
): AppstrateConnectMeta | undefined {
  const meta = connect?._meta?.[APPSTRATE_CONNECT_META_KEY];
  return meta && typeof meta === "object" ? (meta as AppstrateConnectMeta) : undefined;
}
