// SPDX-License-Identifier: Apache-2.0

/**
 * Bridge between an integration's live credentials source and the
 * `ProxyCredentialsPayload` shape `executeProviderCall` consumes.
 *
 * The generic `api_call` tool (provider→integration unification) reuses
 * the exact credential-proxy core that used to back `provider_call`. That
 * core fetches a {@link ProxyCredentialsPayload} per call; here we
 * synthesise one from the integration's resolved `delivery.http` plan:
 *
 *   - the injected header (name/prefix/value) maps to
 *     `credentialHeaderName` / `credentialHeaderPrefix` + a synthetic
 *     credential field holding the rendered token, which
 *     `buildInjectedCredentialHeader` reads via `credentialFieldName`;
 *   - the auth's decrypted `fields` are exposed under `credentials` so an
 *     agent can still `{{var}}`-substitute them into the URL / headers /
 *     body, matching legacy provider ergonomics;
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
  fetchCredentials: (providerId: string) => Promise<ProxyCredentialsPayload>;
  refreshCredentials: (providerId: string) => Promise<ProxyCredentialsPayload>;
}

/**
 * Build the `fetch` / `refresh` credential adapters for one integration's
 * `api_call` tool. `providerId` is ignored (the integration is fixed by
 * closure) — the parameter exists only to satisfy the `ProviderCallDeps`
 * signature shared with `provider_call`.
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
      await source.refreshOnUnauthorized(authKey).catch(() => false);
      return toPayload();
    },
  };
}
