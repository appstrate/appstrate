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

/** The browse catalogue contains the system integrations Appstrate offers. */
export function isCatalogueIntegration(integration: IntegrationSummaryWire): boolean {
  return integration.source === "system";
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

/** Add or remove the catalogue query flag without disturbing list filters. */
export function catalogueSearch(search: string, open: boolean): string {
  const params = new URLSearchParams(search);
  if (open) params.set("catalogue", "1");
  else {
    params.delete("catalogue");
    params.delete("catalogue_q");
    params.delete("catalogue_status");
  }
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function readCatalogueFilters(search: string): {
  query: string;
  statuses: IntegrationStatus[];
} {
  const params = new URLSearchParams(search);
  const statuses = (params.get("catalogue_status") ?? "")
    .split(",")
    .filter((value): value is IntegrationStatus =>
      (INTEGRATION_STATUSES as readonly string[]).includes(value),
    );
  return { query: params.get("catalogue_q") ?? "", statuses };
}

export function catalogueFilterSearch(
  search: string,
  { query, statuses }: { query: string; statuses: readonly IntegrationStatus[] },
): string {
  const params = new URLSearchParams(search);
  if (query) params.set("catalogue_q", query);
  else params.delete("catalogue_q");
  if (statuses.length) params.set("catalogue_status", statuses.join(","));
  else params.delete("catalogue_status");
  const next = params.toString();
  return next ? `?${next}` : "";
}
