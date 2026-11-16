// SPDX-License-Identifier: Apache-2.0

import type { IntegrationIndexItem } from "@appstrate/shared-types";
import { matchesSearch } from "./strings";

export const INTEGRATION_ORIGINS = ["system", "custom"] as const;
/**
 * `source.kind`, read straight off the index row's `source_kind` (or a manifest's own), not a
 * choice anyone makes: `none` (the platform calls the API itself), `remote` (a hosted MCP
 * server) or `local` (an MCP server the integration ships, run in the sandbox).
 */
export const INTEGRATION_SOURCES = ["none", "remote", "local"] as const;

export type IntegrationOrigin = (typeof INTEGRATION_ORIGINS)[number];
export type IntegrationSource = (typeof INTEGRATION_SOURCES)[number];

export function integrationOrigin(integration: IntegrationIndexItem): IntegrationOrigin {
  return integration.source === "system" ? "system" : "custom";
}

export function filterIntegrations<T extends IntegrationIndexItem>(
  integrations: T[],
  {
    query,
    origins,
    sources,
  }: {
    query: string;
    origins?: IntegrationOrigin[];
    sources?: IntegrationSource[];
  },
): T[] {
  return integrations.filter((integration) => {
    if (origins?.length && !origins.includes(integrationOrigin(integration))) return false;
    if (sources?.length && !sources.includes(integration.source_kind)) return false;
    const { id, name, description, keywords } = integration;
    return matchesSearch(query, [id, name, description, keywords]);
  });
}
