// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS integration credential helpers — alias-aware field reader +
 * per-auth `delivery.http` plan. Consumed by the platform's
 * spawn/credentials resolvers and the sidecar's MITM listener.
 */

import type { IntegrationManifest } from "@appstrate/core/integration";
import type { ProxyCredentialsPayload } from "./proxy-primitives.ts";

/**
 * Camel-cased manifest aliases → snake_case credential storage keys.
 * Bidirectional: the resolver looks up both forms transparently.
 *
 * Source: proposal §4.1.3 (Fields exposed implicitly by auth type) +
 * legacy `DecryptedCredentials` shape used by `credentials.ts`.
 */
export const ALIAS_MAP: Readonly<Record<string, string>> = {
  accessToken: "access_token",
  refreshToken: "refresh_token",
  idToken: "id_token",
  tokenType: "token_type",
  expiresAt: "expires_at",
  accessTokenSecret: "access_token_secret",
  consumerKey: "consumer_key",
  consumerSecret: "consumer_secret",
  accountEmail: "account_email",
  accountId: "account_id",
  apiKey: "api_key",
  credentialsJson: "credentials_json",
};

/** Reverse map — snake_case → camelCase. Built once. */
const REVERSE_ALIAS_MAP: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ALIAS_MAP).map(([camel, snake]) => [snake, camel]),
);

/** Per-auth resolved credentials (a single entry in the multi-auth payload). */
export interface ResolvedAuthCredentials {
  /** Auth key as declared in `auths.{key}` of the manifest. */
  authKey: string;
  /** Auth type (`oauth2`, `oauth1`, `api_key`, `basic`, `custom`). */
  authType: string;
  /**
   * Credential fields, keyed by their **storage** name (snake_case).
   * Lookups via {@link readCredentialField} also work with the
   * camelCase manifest alias.
   */
  fields: Readonly<Record<string, string>>;
  /** URL allowlist from the manifest. Same string format as legacy. */
  authorizedUris: readonly string[];
  /** Audience value if declared (RFC 8707 binding token). */
  audience?: string;
  /** Identity claims extracted by `extractTokenIdentity` — passthrough metadata. */
  identityClaims?: Readonly<Record<string, string>>;
  /** Token expiry as ISO-8601 when known. */
  expiresAt?: string;
  /** Granted OAuth scopes (for `connection.scopesGranted` UI surfaces). */
  scopesGranted?: readonly string[];
}

/** Multi-auth payload consumed by the sidecar MITM planner. */
export interface IntegrationCredentialsPayload {
  /** One entry per declared auth that has been connected. */
  auths: ResolvedAuthCredentials[];
}

/**
 * Project an already-decrypted credentials object to a flat
 * `Record<string, string>`, dropping non-string (incl. `undefined`)
 * values. Shared by the credential-envelope decryptors (`./credential-decrypt.ts`)
 * and the provider-side credential resolvers so the projection rule lives once.
 * Stays here (no crypto dependency) so the sidecar can import this module
 * without pulling in the encryption keyring.
 */
export function projectToStringMap(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Read a credential field by its **manifest-side** name (camelCase OR
 * snake_case). Returns `undefined` if neither form is set.
 *
 * Used by every `delivery.*.from` / `valueFrom` resolution so authors
 * can write `from: "accessToken"` regardless of how the field is
 * stored.
 */
export function readCredentialField(
  fields: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  if (fields[name] !== undefined) return fields[name];
  // Manifest used camelCase, storage used snake_case (or vice versa).
  const alias = ALIAS_MAP[name] ?? REVERSE_ALIAS_MAP[name];
  if (alias && fields[alias] !== undefined) return fields[alias];
  return undefined;
}

// ─────────────────────────────────────────────
// Delivery — HTTP
// ─────────────────────────────────────────────

/**
 * Plan returned by {@link resolveHttpDelivery}. The proxy uses this to
 * decide whether to inject a header and what value to set; the
 * `allowServerOverride` flag mirrors the manifest setting (default
 * false → proxy strips any caller-supplied header of the same name
 * before injection).
 */
export interface HttpDeliveryPlan {
  headerName: string;
  headerPrefix: string;
  /** Rendered, post-encoding value ready to be sent as the header value. */
  value: string;
  /** Mirrors manifest; default `false` means the proxy MUST strip caller overrides. */
  allowServerOverride: boolean;
}

/**
 * Wire payload returned by both `/internal/integration-credentials/{scope}/{name}`
 * endpoints (GET read-current + POST refresh). Single source of truth shared by
 * the platform resolver (producer) and the sidecar `MitmCredentialSource`
 * (consumer) — the `auths[]` entries feed the MITM planner; `deliveryPlans` and
 * `expiresAtEpochMs` are sibling maps the sidecar needs but the planner doesn't.
 */
export interface IntegrationCredentialsWire {
  auths: ReadonlyArray<ResolvedAuthCredentials>;
  deliveryPlans: Readonly<Record<string, HttpDeliveryPlan>>;
  expiresAtEpochMs: Readonly<Record<string, number | null>>;
}

const AUTH_TYPE_HTTP_DEFAULTS: Readonly<
  Record<string, { headerName: string; headerPrefix: string; valueFrom: string }>
> = {
  oauth2: { headerName: "Authorization", headerPrefix: "Bearer ", valueFrom: "accessToken" },
  oauth1: { headerName: "Authorization", headerPrefix: "", valueFrom: "accessToken" },
  api_key: { headerName: "X-Api-Key", headerPrefix: "", valueFrom: "apiKey" },
  basic: { headerName: "Authorization", headerPrefix: "Basic ", valueFrom: "" },
  custom: { headerName: "", headerPrefix: "", valueFrom: "" },
};

/**
 * Resolve a `delivery.http` plan for a single auth. Returns `null`
 * when no header can be injected (e.g. `custom` auth without explicit
 * `delivery.http`) — callers should treat that as "the proxy does not
 * inject anything for this auth on this URL".
 *
 * Defaults are derived from the auth type per proposal §4.1.4 — `oauth2`
 * sends `Authorization: Bearer <accessToken>`, `api_key` sends
 * `X-Api-Key: <apiKey>` etc. Explicit manifest values always win.
 */
export function resolveHttpDelivery(
  authType: string,
  fields: Readonly<Record<string, string>>,
  http: NonNullable<NonNullable<IntegrationManifest["auths"]>[string]["delivery"]["http"]>,
): HttpDeliveryPlan | null {
  const defaults = AUTH_TYPE_HTTP_DEFAULTS[authType] ?? {
    headerName: "",
    headerPrefix: "",
    valueFrom: "",
  };
  const headerName = http.headerName ?? defaults.headerName;
  if (!headerName) return null;

  const headerPrefix = http.headerPrefix ?? defaults.headerPrefix;

  let value: string;
  const valueFrom = http.valueFrom ?? defaults.valueFrom;
  if (typeof valueFrom === "string") {
    if (valueFrom.length === 0) {
      // basic / custom with no explicit valueFrom — value is empty.
      // The proxy is then responsible for building the value itself
      // (e.g. basic auth concatenates username:password and base64s it).
      value = "";
    } else {
      value = readCredentialField(fields, valueFrom) ?? "";
    }
  } else {
    value = renderTemplate(valueFrom.template, fields, valueFrom.encoding);
  }

  if (value.length === 0 && (authType === "basic" || authType === "custom") && !http.valueFrom) {
    // Default-shape basic auth: compute `base64(username:password)`.
    if (authType === "basic") {
      const username = readCredentialField(fields, "username") ?? "";
      const password = readCredentialField(fields, "password") ?? "";
      value = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    }
  }

  return {
    headerName,
    headerPrefix,
    value,
    allowServerOverride: http.allowServerOverride === true,
  };
}

/**
 * Synthetic credential field holding the rendered injection token. Named
 * defensively so it can't collide with a real manifest credential field
 * (which must match `/^[a-z][a-z0-9_]*$/`). The payload self-describes the
 * field name via `credentialFieldName`, so this value is opaque to consumers.
 */
export const PROXY_INJECTED_FIELD = "__appstrate_credential_proxy_token__";

/**
 * Synthesise the {@link ProxyCredentialsPayload} that `proxyCall` /
 * `executeApiCall` consume, from an auth's decrypted `fields` and its
 * resolved {@link HttpDeliveryPlan}. Single source of truth shared by the
 * external-runner path (`apps/api` credential-proxy resolver) and the
 * in-container path (sidecar `api-call-credentials`), so the payload shape
 * and injection contract cannot drift between them.
 *
 * `plan === null` (e.g. `custom` auth with no `delivery.http`, or a plan
 * whose `headerName` is empty) means no server-side header injection — the
 * agent supplies its own auth via `{{var}}` substitution against `credentials`.
 */
export function buildProxyCredentialsPayload(opts: {
  fields: Readonly<Record<string, string>>;
  plan: HttpDeliveryPlan | null;
  authorizedUris: readonly string[];
  allowAllUris?: boolean;
}): ProxyCredentialsPayload {
  const { fields, plan, authorizedUris, allowAllUris = false } = opts;
  const credentials: Record<string, string> = { ...fields };
  if (plan) credentials[PROXY_INJECTED_FIELD] = plan.value;
  return {
    credentials,
    authorizedUris: [...authorizedUris],
    allowAllUris,
    ...(plan && plan.headerName
      ? { credentialHeaderName: plan.headerName, credentialHeaderPrefix: plan.headerPrefix }
      : {}),
    credentialFieldName: PROXY_INJECTED_FIELD,
  };
}

function renderTemplate(
  template: string,
  fields: Readonly<Record<string, string>>,
  encoding: "base64" | undefined,
): string {
  const rendered = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = readCredentialField(fields, key);
    if (value !== undefined) return value;
    return "";
  });
  if (encoding === "base64") return Buffer.from(rendered, "utf8").toString("base64");
  return rendered;
}
