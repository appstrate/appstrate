// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS integration credential helpers — alias-aware field reader +
 * per-auth `delivery.http` plan. Consumed by the platform's
 * spawn/credentials resolvers and the sidecar's MITM listener.
 */

import { jsonText } from "@appstrate/afps-shared/json-text";
import type { ProxyCredentialsPayload } from "./proxy-primitives.ts";

// `HttpDeliveryPlan` lives once in @appstrate/afps-runtime (the dependency-free
// bottom layer this package already depends on); re-export it so existing
// `@appstrate/connect` consumers keep their import path.
export { type HttpDeliveryPlan } from "@appstrate/afps-runtime/resolvers";
import type { HttpDeliveryPlan } from "@appstrate/afps-runtime/resolvers";

/** Per-auth resolved credentials (a single entry in the multi-auth payload). */
export interface ResolvedAuthCredentials {
  /** Auth key as declared in `auths.{key}` of the manifest. */
  authKey: string;
  /** Auth type (`oauth2`, `api_key`, `basic`, `custom`). */
  authType: string;
  /**
   * Credential fields, keyed by their canonical **storage** name (snake_case)
   * — the same convention manifest `delivery`/`{{var}}` refs must use.
   */
  fields: Readonly<Record<string, string>>;
  /** URL allowlist from the manifest (AFPS `authorized_uris` glob format). */
  authorizedUris: readonly string[];
  /**
   * RFC 8707 resource indicator declared by the manifest
   * (`auths.{key}.resource`). AFPS §7.3 name — matches the RFC.
   */
  resource?: string;
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
  /** {@link IntegrationCredentialsWire.credentialRevision} of the credential these auths carry. */
  credentialRevision?: string;
}

/**
 * The ONE rule turning a credential bag into the flat `Record<string, string>`
 * that templates substitute (`{$credential.<field>}`) and login tools read.
 * Credentials may hold any JSON type (JSON Schema 2020-12, AFPS §7.5): a string
 * passes through, any other value is JSON-encoded (`5432` → `"5432"`, `true` →
 * `"true"`, `["a","b"]` → `'["a","b"]'`), so a declared non-string credential
 * is delivered rather than silently lost (#1897). `null` and `undefined` are an
 * absent credential and are left out — never rendered as the text `"null"`.
 * Pure (no crypto dependency) so the sidecar can import this module without
 * pulling in the encryption keyring.
 */
export function toCredentialStringMap(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    out[k] = jsonText(v);
  }
  return out;
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
  /**
   * Consecutive upstream rejections counted against this non-OAuth2 connection; absent when none.
   * The sidecar reports the next successful call, which ends the streak.
   */
  rejectionStreak?: number;
  /**
   * Opaque revision of the stored credential this payload carries; absent on a connect run's empty
   * payload. Sent back on refresh and success reports so they act on this credential only.
   */
  credentialRevision?: string;
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
      ? {
          credentialHeaderName: plan.headerName,
          credentialHeaderPrefix: plan.headerPrefix,
          credentialAllowServerOverride: plan.allowServerOverride === true,
        }
      : {}),
    credentialFieldName: PROXY_INJECTED_FIELD,
  };
}
