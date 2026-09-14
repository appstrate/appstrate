// SPDX-License-Identifier: Apache-2.0

import type { IntegrationSummaryWire } from "../hooks/use-integrations";

export const INTEGRATION_STATUSES = ["active", "inactive"] as const;
export const INTEGRATION_ORIGINS = ["system", "custom"] as const;
/**
 * Two attributes of how an integration reaches its service, read off the
 * manifest's `source.kind` — not a choice anyone makes while adding one.
 *
 * - **Execution**: nothing runs on our side (`remote`), or a local MCP server
 *   package runs in the sandbox (`local`).
 * - **Protocol**, which only varies when remote: the platform calls the
 *   service's API itself (`api`, `source.kind: "none"`), or a hosted MCP server
 *   answers at a URL (`mcp`, `"remote"`). A local integration is always MCP.
 */
export const INTEGRATION_EXECUTIONS = ["remote", "local"] as const;
export const INTEGRATION_PROTOCOLS = ["api", "mcp"] as const;

export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];
export type IntegrationOrigin = (typeof INTEGRATION_ORIGINS)[number];
export type IntegrationExecution = (typeof INTEGRATION_EXECUTIONS)[number];
export type IntegrationProtocol = (typeof INTEGRATION_PROTOCOLS)[number];

function sourceKind(integration: Pick<IntegrationSummaryWire, "manifest">): string | undefined {
  return (integration.manifest as { source?: { kind?: string } }).source?.kind;
}

export function integrationExecution(
  integration: Pick<IntegrationSummaryWire, "manifest">,
): IntegrationExecution {
  return sourceKind(integration) === "local" ? "local" : "remote";
}

/** A manifest with no `source` predates the field and has no MCP backing. */
export function integrationProtocol(
  integration: Pick<IntegrationSummaryWire, "manifest">,
): IntegrationProtocol {
  const kind = sourceKind(integration);
  return kind === "local" || kind === "remote" ? "mcp" : "api";
}

/** The local server package and version range a local integration runs. */
export function localServerRef(
  integration: Pick<IntegrationSummaryWire, "manifest">,
): { name: string; version?: string } | undefined {
  const source = (
    integration.manifest as {
      source?: { kind?: string; server?: { name?: string; version?: string } };
    }
  ).source;
  return source?.kind === "local" && source.server?.name
    ? { name: source.server.name, version: source.server.version }
    : undefined;
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
    executions,
    protocols,
  }: {
    query: string;
    statuses?: IntegrationStatus[];
    origins?: IntegrationOrigin[];
    executions?: IntegrationExecution[];
    protocols?: IntegrationProtocol[];
  },
): IntegrationSummaryWire[] {
  return integrations.filter((integration) => {
    const status = integrationStatus(integration);
    const origin = integrationOrigin(integration);
    if (statuses?.length && !statuses.includes(status)) return false;
    if (origins?.length && !origins.includes(origin)) return false;
    if (executions?.length && !executions.includes(integrationExecution(integration))) return false;
    if (protocols?.length && !protocols.includes(integrationProtocol(integration))) return false;
    return integrationMatchesQuery(integration, query);
  });
}
