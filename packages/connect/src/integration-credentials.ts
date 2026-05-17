// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.1 — credential resolver for the new AFPS `integration`
 * manifest (proposal §4.1.1, §4.1.3, §4.1.4).
 *
 * Pure, DB-free, network-free. Given an integration manifest's `auths`
 * map plus the decrypted credential bundle for each connected auth
 * key, this module produces:
 *
 *   - {@link resolveIntegrationCredentials} — the multi-auth proxy
 *     payload (one entry per declared `auths.{key}`), keyed for
 *     fast URL routing by `authorizedUris` order.
 *   - {@link resolveHttpDelivery} — the header injection plan for a
 *     given auth (header name, prefix, rendered value, override gate).
 *   - {@link resolveEnvDelivery} — the env-var bundle for spawn-time
 *     injection, with `sensitive` masking metadata preserved.
 *   - {@link resolveFilesDelivery} — the tmpfs file plan (path → content
 *     + mode). Actual `fs.write` lives in the runtime/spawn layer
 *     (Phase 1.2a); this module only computes the plan.
 *   - {@link routeRequestToAuth} — given an outbound URL, returns the
 *     auth key whose `authorizedUris` matches first (manifest order),
 *     or `null` if none match.
 *
 * Field aliases:
 *
 *   Credentials are stored using OAuth-canonical snake_case names
 *   (`access_token`, `refresh_token`, …) but the manifest uses the
 *   AFPS camelCase convention (`accessToken`, `refreshToken`). The
 *   resolver applies both directions transparently so manifest authors
 *   can write `from: "accessToken"` and have it resolve against
 *   `credentials.access_token`. {@link ALIAS_MAP} documents the
 *   reverse-canonical mapping.
 *
 * Computed fields:
 *
 *   `delivery.http.valueFrom` accepts either a string ("simple field
 *   reference") or `{ template, encoding }` for templates with optional
 *   post-substitution encoding. Templates use `{{var}}` syntax against
 *   credential fields, then optionally pipe through a whitelisted
 *   encoding (`base64`). Unknown placeholder = template is rendered
 *   with empty substitution; missing-field detection lives in the
 *   caller (we surface the rendered string regardless so log analysis
 *   can see what the proxy actually sent).
 *
 * What lives elsewhere:
 *
 *   - RFC 8707 audience binding → `./audience-binding.ts`
 *   - RFC 9728/8414 discovery   → `./oauth-discovery.ts`
 *   - DB read / token refresh   → `./credentials.ts` (legacy provider
 *     path) / Phase 1.2a runtime (integration spawn).
 */

import type { IntegrationManifest } from "@appstrate/core/integration";
import { matchesAuthorizedUriSpec } from "./proxy-primitives.ts";

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

/** Input bundle for a single auth key: decrypted fields + optional identity claims. */
export interface AuthCredentialBundle {
  fields: Record<string, string>;
  identityClaims?: Record<string, string>;
  expiresAt?: string;
  scopesGranted?: readonly string[];
}

/**
 * Resolve a full multi-auth payload from a manifest + per-auth bundles.
 *
 * `bundles` is keyed by `authKey` (the same string used in
 * `manifest.auths.{key}`). Missing entries are tolerated — the
 * `missingRequiredAuthKeys` field reports which `required: true` auths
 * weren't supplied, so the caller (typically Phase 1.2a runtime) can
 * block the spawn with a structured error.
 */
export function resolveIntegrationCredentials(
  manifest: Pick<IntegrationManifest, "auths">,
  bundles: Readonly<Record<string, AuthCredentialBundle>>,
): IntegrationCredentialsPayload {
  const declaredAuths = manifest.auths ?? {};
  const out: ResolvedAuthCredentials[] = [];
  const missing: string[] = [];

  for (const [authKey, authDef] of Object.entries(declaredAuths)) {
    const bundle = bundles[authKey];
    const isRequired = authDef.required !== false; // default true (§4.1.1)

    if (!bundle) {
      if (isRequired) missing.push(authKey);
      continue;
    }

    out.push({
      authKey,
      authType: authDef.type,
      fields: Object.freeze({ ...bundle.fields }),
      authorizedUris: Object.freeze([...authDef.authorizedUris]),
      audience: authDef.audience,
      identityClaims: bundle.identityClaims
        ? Object.freeze({ ...bundle.identityClaims })
        : undefined,
      expiresAt: bundle.expiresAt,
      scopesGranted: bundle.scopesGranted ? Object.freeze([...bundle.scopesGranted]) : undefined,
    });
  }

  return { auths: out, missingRequiredAuthKeys: missing };
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

// ─────────────────────────────────────────────
// Delivery — env
// ─────────────────────────────────────────────

/** Single env-var entry in the spawn-time injection plan. */
export interface EnvDeliveryEntry {
  name: string;
  value: string;
  /** Mirrors manifest `sensitive: true` so loggers can mask. */
  sensitive: boolean;
}

/**
 * Resolve a `delivery.env` plan. Each `delivery.env[NAME].from` is
 * resolved against the credential fields; missing fields produce an
 * entry with empty value (caller decides whether to refuse the spawn).
 */
export function resolveEnvDelivery(
  env: NonNullable<NonNullable<IntegrationManifest["auths"]>[string]["delivery"]["env"]>,
  fields: Readonly<Record<string, string>>,
  identityClaims?: Readonly<Record<string, string>>,
): EnvDeliveryEntry[] {
  return Object.entries(env).map(([name, spec]) => ({
    name,
    value: resolveFromReference(spec.from, fields, identityClaims),
    sensitive: spec.sensitive === true,
  }));
}

// ─────────────────────────────────────────────
// Delivery — files
// ─────────────────────────────────────────────

/** Single file entry in the spawn-time tmpfs plan. */
export interface FileDeliveryEntry {
  /** Absolute path inside the container (e.g. `/run/afps/gmail-creds.json`). */
  path: string;
  /** UTF-8 content to write. */
  content: string;
  /** POSIX mode as 4-digit octal string, e.g. `"0400"`. Defaults to `"0400"`. */
  mode: string;
}

/**
 * Resolve a `delivery.files` plan. The runtime (Phase 1.2a) is
 * responsible for actually writing these files on a tmpfs mount and
 * destroying them at run end. We default the mode to `0400` per
 * proposal §4.1.6.1 — "files on tmpfs lisible only by the process".
 */
export function resolveFilesDelivery(
  files: NonNullable<NonNullable<IntegrationManifest["auths"]>[string]["delivery"]["files"]>,
  fields: Readonly<Record<string, string>>,
  identityClaims?: Readonly<Record<string, string>>,
): FileDeliveryEntry[] {
  return Object.entries(files).map(([path, spec]) => ({
    path,
    content: resolveFromReference(spec.from, fields, identityClaims),
    mode: spec.mode ?? "0400",
  }));
}

// ─────────────────────────────────────────────
// URL routing
// ─────────────────────────────────────────────

/**
 * Given an outbound URL and a resolved payload, return the auth key
 * whose `authorizedUris` matches first per manifest order — see
 * proposal §4.1.4 step 1 ("If plusieurs auths matchent la même URL,
 * appliquer celle apparaissant en premier dans `auths`"). Returns
 * `null` when no auth matches (the proxy MUST then forward without
 * credential injection and let the upstream return 401 organically).
 */
export function routeRequestToAuth(
  url: string,
  payload: IntegrationCredentialsPayload,
): ResolvedAuthCredentials | null {
  for (const auth of payload.auths) {
    for (const pattern of auth.authorizedUris) {
      // matchesAuthorizedUriSpec takes (pattern, target) — pattern first.
      if (matchesAuthorizedUriSpec(pattern, url)) return auth;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────

/**
 * Resolve a `from` reference (used by env/files). Accepts a single
 * field name (alias-aware) OR a `{{template}}` string. The template
 * variant matches the `delivery.http.valueFrom: { template, … }` shape
 * but without per-call encoding (env/files take literal UTF-8).
 */
function resolveFromReference(
  ref: string,
  fields: Readonly<Record<string, string>>,
  identityClaims?: Readonly<Record<string, string>>,
): string {
  if (ref.includes("{{")) {
    return renderTemplate(ref, fields, undefined, identityClaims);
  }
  const fromFields = readCredentialField(fields, ref);
  if (fromFields !== undefined) return fromFields;
  if (identityClaims && identityClaims[ref] !== undefined) return identityClaims[ref];
  const alias = ALIAS_MAP[ref] ?? REVERSE_ALIAS_MAP[ref];
  if (alias && identityClaims && identityClaims[alias] !== undefined) return identityClaims[alias];
  return "";
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
