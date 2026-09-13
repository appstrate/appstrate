// SPDX-License-Identifier: Apache-2.0

import type { IntegrationSummaryWire } from "../hooks/use-integrations";

export const INTEGRATION_STATUSES = ["active", "inactive"] as const;
export const INTEGRATION_ORIGINS = ["system", "custom"] as const;
/**
 * How an integration reaches its service — the manifest's `source.kind`, named
 * for people: the platform calls the API itself (`none`), a hosted MCP server
 * answers at a URL (`remote`), or a local MCP server package runs in the
 * sandbox (`local`).
 */
export const INTEGRATION_KINDS = ["api", "mcp-remote", "mcp-local"] as const;

export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];
export type IntegrationOrigin = (typeof INTEGRATION_ORIGINS)[number];
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** A manifest with no `source` predates the field and has no MCP backing. */
export function integrationKind(
  integration: Pick<IntegrationSummaryWire, "manifest">,
): IntegrationKind {
  const kind = (integration.manifest as { source?: { kind?: string } }).source?.kind;
  if (kind === "local") return "mcp-local";
  if (kind === "remote") return "mcp-remote";
  return "api";
}

/** The local MCP server package a `mcp-local` integration runs, if any. */
export function localServerOf(
  integration: Pick<IntegrationSummaryWire, "manifest">,
): string | undefined {
  const source = (
    integration.manifest as { source?: { kind?: string; server?: { name?: string } } }
  ).source;
  return source?.kind === "local" ? source.server?.name : undefined;
}

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
    kinds,
  }: {
    query: string;
    statuses?: IntegrationStatus[];
    origins?: IntegrationOrigin[];
    kinds?: IntegrationKind[];
  },
): IntegrationSummaryWire[] {
  return integrations.filter((integration) => {
    const status = integrationStatus(integration);
    const origin = integrationOrigin(integration);
    if (statuses?.length && !statuses.includes(status)) return false;
    if (origins?.length && !origins.includes(origin)) return false;
    if (kinds?.length && !kinds.includes(integrationKind(integration))) return false;
    return integrationMatchesQuery(integration, query);
  });
}
