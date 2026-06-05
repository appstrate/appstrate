// SPDX-License-Identifier: Apache-2.0

/**
 * Bridge between an integration's live credentials source and the
 * `ProxyCredentialsPayload` shape `executeApiCall` consumes.
 *
 * The generic `api_call` tool runs the credential-proxy core. That
 * core fetches a {@link ProxyCredentialsPayload} per call; here we
 * synthesise one from the integration's resolved `delivery.http` plan:
 *
 *   - the injected header (name/prefix/value) maps to
 *     `credentialHeaderName` / `credentialHeaderPrefix` + a synthetic
 *     credential field holding the rendered token, which
 *     `buildInjectedCredentialHeader` reads via `credentialFieldName`;
 *   - the auth's decrypted `fields` are exposed under `credentials` so an
 *     agent can still `{{var}}`-substitute them into the URL / headers /
 *     body;
 *   - `authorizedUris` is the auth's verbatim allowlist (integrations
 *     always declare ≥1 URI, so `allowAllUris` is always false).
 *
 * `refreshCredentials` delegates to the source's `refreshOnUnauthorized`
 * (per-authKey cooldown + in-flight dedup live in the source) and
 * re-snapshots, so a mid-run 401 retry sees the rotated token — identical
 * to the MITM and remote-HTTP paths.
 */

import type { ProxyCredentialsPayload } from "@appstrate/connect/proxy-primitives";
import { buildProxyCredentialsPayload } from "@appstrate/connect/integration-credentials";
import type { IntegrationCredentialsSource } from "./integration-credentials-source.ts";

export interface ApiCallCredentialAdapter {
  fetchCredentials: (integrationId: string) => Promise<ProxyCredentialsPayload>;
  /**
   * Force a refresh on a mid-run 401. Returns the re-snapshotted payload when
   * the credential was actually rotated (caller retries the request once), or
   * `null` when it was not — the platform `/refresh` already flagged the
   * connection on a terminal failure, so the caller must NOT retry with a
   * stale token.
   */
  refreshCredentials: (integrationId: string) => Promise<ProxyCredentialsPayload | null>;
  /**
   * Whether a 401 can RE-ACQUIRE this auth's credential — oauth2 (token
   * rotation) OR a connect.tool auth whose `reauth_on` covers 401 (mid-run
   * re-login). When `true` the proxy refreshes immediately. When `false`
   * (api_key / basic / a custom auth with no 401 re-login) a forced refresh
   * has nothing to re-acquire and the platform `/refresh` flags the
   * connection — so the proxy first retries the SAME request once (a one-off
   * 401 may be spurious, not a dead key) before letting `refreshCredentials`
   * flag it. Mirrors the MITM listener's `!connectReauth` gate so a
   * connect.tool session is never replayed stale on the api_call path.
   */
  refreshable: boolean;
}

/**
 * Build the `fetch` / `refresh` credential adapters for one integration's
 * `api_call` tool. `integrationId` is ignored (the integration is fixed by
 * closure) — the parameter exists only to satisfy the `ApiCallDeps`
 * signature used by `api_call`.
 */
export function createApiCallCredentialAdapter(opts: {
  source: IntegrationCredentialsSource;
  authKey: string;
  authorizedUris: readonly string[];
  allowAllUris?: boolean;
}): ApiCallCredentialAdapter {
  const { source, authKey, authorizedUris, allowAllUris = false } = opts;

  const toPayload = (): ProxyCredentialsPayload => {
    const snap = source.snapshot();
    const plan = snap.deliveryPlans[authKey] ?? null;
    const auth = snap.auths.find((a) => a.authKey === authKey);
    return buildProxyCredentialsPayload({
      fields: auth?.fields ?? {},
      plan,
      authorizedUris,
      allowAllUris,
    });
  };

  return {
    fetchCredentials: async () => toPayload(),
    refreshCredentials: async () => {
      // Retry ONLY when the credential was actually rotated. A false result
      // (terminal 410 → connection flagged, or transient/cooldown) means
      // re-issuing the request would just 401 again — return null so the proxy
      // skips the retry instead of masking a dead credential as a success.
      const rotated = await source.refreshOnUnauthorized(authKey).catch(() => false);
      return rotated ? toPayload() : null;
    },
    // oauth2 rotates; a connect.tool auth re-logs in on a 401 (`shouldReauth`).
    // Both re-acquire the credential, so skip the stale-credential replay and
    // refresh immediately. Optional-chained: real sources always implement
    // `shouldReauth`, test fakes may not.
    refreshable:
      source.current().auths.find((a) => a.authKey === authKey)?.authType === "oauth2" ||
      source.shouldReauth?.(authKey, 401) === true,
  };
}
