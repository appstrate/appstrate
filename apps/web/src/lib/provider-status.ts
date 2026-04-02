// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";

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
 * Check whether any provider in the list is not connected.
 */
export function hasDisconnectedProviders(providers: Array<{ status: string }>): boolean {
  return providers.some((p) => !isProviderStatusConnected(p.status));
}

/**
 * Compute a summary string for the providers section.
 */
export function computeProvidersSummary(
  providers: Array<{ status: string; scopesSufficient?: boolean | null }>,
  t: TFunction<"flows">,
): { text: string; connectedCount: number; actionCount: number } | null {
  if (providers.length === 0) return null;

  let connectedCount = 0;
  let actionCount = 0;

  for (const svc of providers) {
    if (isProviderStatusConnected(svc.status) && svc.scopesSufficient !== false) {
      connectedCount++;
    } else {
      actionCount++;
    }
  }

  const parts: string[] = [];
  if (connectedCount > 0) {
    parts.push(t("detail.providersSummaryOk", { connected: connectedCount }));
  }
  if (actionCount > 0) {
    parts.push(t("detail.providersSummaryAction", { count: actionCount }));
  }

  return { text: parts.join(" \u2014 "), connectedCount, actionCount };
}
