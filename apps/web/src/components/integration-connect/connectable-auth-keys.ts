// SPDX-License-Identifier: Apache-2.0

import type { IntegrationAuthStatus, IntegrationManifestView } from "../../hooks/use-integrations";

/**
 * Whether an oauth2 auth can start a connect flow: it needs a usable client —
 * an org-registered one (`has_oauth_client`), the shared platform client
 * (`has_system_client`, `SYSTEM_INTEGRATIONS`), or one auto-provisioned
 * at connect time for remote MCP integrations (`client_auto_provisioned`,
 * MCP-spec CIMD/DCR). Without any, the server refuses connect with 403. Single
 * source of truth for the gate shared by the agent surfaces and the integration
 * detail page.
 */
export function isOauthAuthConnectable(status: IntegrationAuthStatus | undefined): boolean {
  return Boolean(
    status?.has_oauth_client || status?.has_system_client || status?.client_auto_provisioned,
  );
}

/**
 * Auth keys the actor can actually start a connect flow on. oauth2 auths gate on
 * {@link isOauthAuthConnectable}; non-oauth2 auths (api_key / basic / custom)
 * carry no client and are always connectable via the fields modal.
 */
export function connectableAuthKeys(
  manifest: IntegrationManifestView,
  authStatuses: IntegrationAuthStatus[],
): Set<string> {
  const out = new Set<string>();
  const declared = manifest.auths ?? {};
  for (const key of Object.keys(declared)) {
    if (declared[key]?.type !== "oauth2") {
      out.add(key);
      continue;
    }
    if (isOauthAuthConnectable(authStatuses.find((s) => s.auth_key === key))) out.add(key);
  }
  return out;
}
