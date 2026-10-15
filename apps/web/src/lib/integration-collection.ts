// SPDX-License-Identifier: Apache-2.0

import type { IntegrationIndexItem } from "@appstrate/shared-types";
import { matchesSearch } from "./strings";

export const INTEGRATION_ORIGINS = ["system", "custom"] as const;
/**
 * Two attributes of how an integration reaches its service, read off its
 * `source.kind` — not a choice anyone makes while adding one.
 *
 * - **Execution**: nothing runs on our side (`remote`), or a local MCP server
 *   package runs in the sandbox (`local`).
 * - **Protocol**, which only varies when remote: the platform calls the
 *   service's API itself (`api`, `source.kind: "none"`), or a hosted MCP server
 *   answers at a URL (`mcp`, `"remote"`). A local integration is always MCP.
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
