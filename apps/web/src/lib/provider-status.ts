// SPDX-License-Identifier: Apache-2.0

/**
 * Check whether a provider status string represents a connected state.
 */
export function isProviderStatusConnected(status: string): boolean {
  return status === "connected" || status === "needs_reconnection";
}

/**
 * Check whether a provider is connected within a given connection profile.
 */
export function isProviderConnectedInProfile(
  providerId: string,
  profileConnections?: Array<{ providerId: string }>,
): boolean {
  return profileConnections?.some((c) => c.providerId === providerId) ?? false;
}

/**
 * Check whether any provider in the list is not connected or has insufficient scopes.
 */
export function hasDisconnectedProviders(
  providers: Array<{ status: string; scopesSufficient?: boolean | null }>,
): boolean {
  return providers.some(
    (p) => !isProviderStatusConnected(p.status) || p.scopesSufficient === false,
  );
}
