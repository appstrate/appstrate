// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

/**
 * Canonical `delivery.http` credential-injection resolver, shared by the
 * platform (`@appstrate/connect` re-exports these) and the portable
 * `appstrate run` CLI ({@link ./integration-api-call.ts}).
 *
 * afps-runtime is the dependency-free bottom layer, so the single copy lives
 * here and `@appstrate/connect` (which already depends on this package)
 * imports + re-exports it — there is no longer a hand-maintained mirror.
 *
 * The resolver is credential-source agnostic: it takes the auth type, the
 * decrypted credential fields, and the manifest's `delivery.http` block, and
 * returns the header name + rendered value the proxy injects (or `null` when
 * nothing should be injected).
 */

/** Subset of `auths.{key}.delivery.http` the resolver consumes (structural). */
export interface HttpDeliveryConfig {
  headerName?: string;
  headerPrefix?: string;
  valueFrom?: string | { template: string; encoding?: "base64" };
  allowServerOverride?: boolean;
}

/**
 * Plan returned by {@link resolveHttpDelivery}. The proxy uses this to decide
 * whether to inject a header and what value to set; `allowServerOverride`
 * mirrors the manifest setting (default `false` → the proxy strips any
 * caller-supplied header of the same name before injection).
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
 * Camel-cased manifest aliases → snake_case credential storage keys.
 * Bidirectional: {@link readCredentialField} looks up both forms transparently
 * so a manifest author can write `from: "accessToken"` regardless of how the
 * field was stored.
 *
 * Source: proposal §4.1.3 (fields exposed implicitly by auth type).
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

/**
 * Read a credential field by its **manifest-side** name (camelCase OR
 * snake_case). Returns `undefined` if neither form is set.
 */
export function readCredentialField(
  fields: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  if (fields[name] !== undefined) return fields[name];
  const alias = ALIAS_MAP[name] ?? REVERSE_ALIAS_MAP[name];
  if (alias && fields[alias] !== undefined) return fields[alias];
  return undefined;
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

function renderTemplate(
  template: string,
  fields: Readonly<Record<string, string>>,
  encoding: "base64" | undefined,
): string {
  const rendered = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    return readCredentialField(fields, key) ?? "";
  });
  if (encoding === "base64") return Buffer.from(rendered, "utf8").toString("base64");
  return rendered;
}

/**
 * Resolve a `delivery.http` plan for a single auth. Returns `null` when no
 * header can be injected (e.g. `custom` auth without explicit `delivery.http`)
 * — callers treat that as "the proxy injects nothing for this auth".
 *
 * Defaults are derived from the auth type per proposal §4.1.4 — `oauth2` sends
 * `Authorization: Bearer <accessToken>`, `api_key` sends `X-Api-Key: <apiKey>`,
 * etc. Explicit manifest values always win.
 */
export function resolveHttpDelivery(
  authType: string,
  fields: Readonly<Record<string, string>>,
  http: HttpDeliveryConfig | undefined,
): HttpDeliveryPlan | null {
  const defaults = AUTH_TYPE_HTTP_DEFAULTS[authType] ?? {
    headerName: "",
    headerPrefix: "",
    valueFrom: "",
  };
  const headerName = http?.headerName ?? defaults.headerName;
  if (!headerName) return null;

  const headerPrefix = http?.headerPrefix ?? defaults.headerPrefix;

  let value: string;
  const valueFrom = http?.valueFrom ?? defaults.valueFrom;
  if (typeof valueFrom === "string") {
    // basic / custom with no explicit valueFrom — value is empty; the proxy
    // builds the value itself (e.g. basic auth base64s username:password).
    value = valueFrom.length === 0 ? "" : (readCredentialField(fields, valueFrom) ?? "");
  } else {
    value = renderTemplate(valueFrom.template, fields, valueFrom.encoding);
  }

  if (value.length === 0 && authType === "basic" && !http?.valueFrom) {
    const username = readCredentialField(fields, "username") ?? "";
    const password = readCredentialField(fields, "password") ?? "";
    value = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  }

  return {
    headerName,
    headerPrefix,
    value,
    allowServerOverride: http?.allowServerOverride === true,
  };
}
