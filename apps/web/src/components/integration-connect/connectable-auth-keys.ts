// SPDX-License-Identifier: Apache-2.0

import type { IntegrationAuthStatus, IntegrationManifestView } from "../../hooks/use-integrations";

/**
 * An oauth2 auth can connect only with a usable client (org-registered, shared platform, or
 * auto-provisioned for remote MCP); otherwise the server refuses with 403.
 */
export function isOauthAuthConnectable(status: IntegrationAuthStatus | undefined): boolean {
  return Boolean(
    status?.has_oauth_client || status?.has_system_client || status?.client_auto_provisioned,
  );
}

/** Non-oauth2 auths carry no client and are always connectable via the fields modal. */
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
