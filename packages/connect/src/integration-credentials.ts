// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS integration credential helpers — alias-aware field reader +
 * per-auth `delivery.http` plan. Consumed by the platform's
 * spawn/credentials resolvers and the sidecar's MITM listener.
 */

import type { IntegrationManifest } from "@appstrate/core/integration";

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

/** The full multi-auth payload returned by {@link resolveIntegrationCredentials}. */
export interface IntegrationCredentialsPayload {
  /** One entry per declared auth that has been connected. */
  auths: ResolvedAuthCredentials[];
  /** Set of auth keys whose `required: true` declaration is unmet. */
  missingRequiredAuthKeys: string[];
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

function renderTemplate(
  template: string,
  fields: Readonly<Record<string, string>>,
  encoding: "base64" | undefined,
  identityClaims?: Readonly<Record<string, string>>,
): string {
  const rendered = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = readCredentialField(fields, key);
    if (value !== undefined) return value;
    if (identityClaims) {
      if (identityClaims[key] !== undefined) return identityClaims[key];
      const alias = ALIAS_MAP[key] ?? REVERSE_ALIAS_MAP[key];
      if (alias && identityClaims[alias] !== undefined) return identityClaims[alias];
    }
    return "";
  });
  if (encoding === "base64") return Buffer.from(rendered, "utf8").toString("base64");
  return rendered;
}
