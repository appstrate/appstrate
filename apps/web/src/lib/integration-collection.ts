// SPDX-License-Identifier: Apache-2.0

import type { IntegrationSummaryWire } from "../hooks/use-integrations";

export const INTEGRATION_STATUSES = ["active", "inactive"] as const;
export const INTEGRATION_ORIGINS = ["system", "custom"] as const;

export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];
export type IntegrationOrigin = (typeof INTEGRATION_ORIGINS)[number];

export function integrationStatus(integration: IntegrationSummaryWire): IntegrationStatus {
  return integration.active ? "active" : "inactive";
}

export function integrationOrigin(integration: IntegrationSummaryWire): IntegrationOrigin {
  return integration.source === "system" ? "system" : "custom";
}

/**
 * The organisation collection is not the catalogue. It contains every custom
 * integration the organisation owns, including inactive ones that still need
 * to be administrable, plus the system integrations activated in this
 * workspace.
 */
export function isOrganizationIntegration(integration: IntegrationSummaryWire): boolean {
  return integration.source === "local" || Boolean(integration.active);
}

export function integrationMatchesQuery(
  integration: IntegrationSummaryWire,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const manifest = integration.manifest;
  return (
    integration.id.toLowerCase().includes(normalized) ||
    (manifest.display_name?.toLowerCase().includes(normalized) ?? false) ||
    (manifest.description?.toLowerCase().includes(normalized) ?? false) ||
    (manifest.keywords?.some((keyword) => keyword.toLowerCase().includes(normalized)) ?? false)
  );
}

export function filterIntegrations(
  integrations: IntegrationSummaryWire[],
  {
    query,
    statuses,
    origins,
  }: {
    query: string;
    statuses?: IntegrationStatus[];
    origins?: IntegrationOrigin[];
  },
): IntegrationSummaryWire[] {
  return integrations.filter((integration) => {
    const status = integrationStatus(integration);
    const origin = integrationOrigin(integration);
    if (statuses?.length && !statuses.includes(status)) return false;
    if (origins?.length && !origins.includes(origin)) return false;
    return integrationMatchesQuery(integration, query);
  });
}
