// SPDX-License-Identifier: Apache-2.0

import type { IntegrationAuthStatus, IntegrationManifestView } from "../../hooks/use-integrations";

/**
 * Auth keys the actor can actually start a connect flow on. oauth2 auths
 * require an OAuth client — either admin-registered (`has_oauth_client`) or
 * auto-provisioned at connect time for remote MCP integrations
 * (`client_auto_provisioned`, MCP-spec CIMD/DCR); without either the server
 * refuses connect with 403. Non-oauth2 auths (api_key / basic / custom) carry
 * no client and are always connectable via the fields modal. Mirrors the gate
 * the integration detail page applies.
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
    const status = authStatuses.find((s) => s.auth_key === key);
    if (status?.has_oauth_client || status?.client_auto_provisioned) out.add(key);
  }
  return out;
}
