// SPDX-License-Identifier: Apache-2.0

/**
 * Check whether a provider status string represents a connected state.
 */
export function isProviderStatusConnected(status: string): boolean {
  return status === "connected" || status === "needs_reconnection";
}

/**
 * Check whether a provider is connected within a given connection profile.
 * Returns false if the connection exists but needs reconnection.
 *
 * profileConnections is scoped to the current application via X-App-Id header
 * (backend filters by providerCredentialId). Since each app has at most one
 * credential per provider (PK on applicationProviderCredentials), there is at
 * most one connection per provider in the array for the current app context.
 */
export function isProviderConnectedInProfile(
  providerId: string,
  profileConnections?: Array<{ providerId: string; needsReconnection?: boolean }>,
): boolean {
  const conn = profileConnections?.find((c) => c.providerId === providerId);
  return !!conn && !conn.needsReconnection;
}

/**
 * Check whether any provider in the list is not connected or has insufficient scopes.
 */
export function hasDisconnectedProviders(
  providers: Array<{ status: string; scopesSufficient?: boolean | null }>,
): boolean {
  return providers.some((p) => p.status !== "connected" || p.scopesSufficient === false);
}
