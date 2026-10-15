// SPDX-License-Identifier: Apache-2.0

import type { IntegrationIndexItem } from "@appstrate/shared-types";
import { matchesSearch } from "./strings";

export const INTEGRATION_ORIGINS = ["system", "custom"] as const;
/**
 * Read off `source.kind`, not a choice anyone makes. Execution: `remote` (nothing runs on our
 * side) or `local` (MCP server package in the sandbox). Protocol, varying only when remote:
 * `api` (`source.kind: "none"`, the platform calls the API itself) or `mcp` (a hosted server).
 */
export const INTEGRATION_EXECUTIONS = ["remote", "local"] as const;
export const INTEGRATION_PROTOCOLS = ["api", "mcp"] as const;

export type IntegrationOrigin = (typeof INTEGRATION_ORIGINS)[number];
export type IntegrationExecution = (typeof INTEGRATION_EXECUTIONS)[number];
export type IntegrationProtocol = (typeof INTEGRATION_PROTOCOLS)[number];
/** `source.kind`: the index row's `source_kind`, or a manifest's own. */
type IntegrationSourceKind = IntegrationIndexItem["source_kind"];

export function integrationExecution(kind: IntegrationSourceKind): IntegrationExecution {
  return kind === "local" ? "local" : "remote";
}

export function integrationProtocol(kind: IntegrationSourceKind): IntegrationProtocol {
  return kind === "none" ? "api" : "mcp";
}

export function integrationOrigin(integration: IntegrationIndexItem): IntegrationOrigin {
  return integration.source === "system" ? "system" : "custom";
}

export function filterIntegrations(
  integrations: IntegrationIndexItem[],
  {
    query,
    origins,
    executions,
    protocols,
  }: {
    query: string;
    origins?: IntegrationOrigin[];
    executions?: IntegrationExecution[];
    protocols?: IntegrationProtocol[];
  },
): IntegrationIndexItem[] {
  return integrations.filter((integration) => {
    if (origins?.length && !origins.includes(integrationOrigin(integration))) return false;
    const kind = integration.source_kind;
    if (executions?.length && !executions.includes(integrationExecution(kind))) return false;
    if (protocols?.length && !protocols.includes(integrationProtocol(kind))) return false;
    const { id, name, description, keywords } = integration;
    return matchesSearch(query, [id, name, description, keywords]);
  });
}
