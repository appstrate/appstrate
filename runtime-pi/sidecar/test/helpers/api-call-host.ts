// SPDX-License-Identifier: Apache-2.0

/**
 * Test helper mirroring the production wiring in `integrations-boot.ts`:
 * host the generic `api_call` (+ optional `api_upload`) tools as TRUSTED
 * in-process MCP servers on a shared {@link McpHost}. Tests then expose
 * `host.buildTools()` via `additionalMcpToolsProvider` (createApp) or
 * `additionalToolsProvider` (mountMcp) — the same single pipeline the
 * sidecar uses, so they exercise the real namespacing + dispatch path.
 */

import { createInProcessPair, wrapClient } from "@appstrate/mcp-transport";
import { McpHost } from "../../mcp-host.ts";
import {
  createApiCallToolDefs,
  type ApiCallIntegrationConfig,
  type ApiCallToolDeps,
} from "../../mcp.ts";

export async function buildApiCallHost(
  integs: ApiCallIntegrationConfig[],
  deps: ApiCallToolDeps,
): Promise<McpHost> {
  const host = new McpHost();
  for (const integ of integs) {
    const defs = createApiCallToolDefs(integ, deps);
    const pair = await createInProcessPair(defs, {
      serverInfo: { name: `test-api-call-${integ.integrationId}`, version: "1" },
    });
    await host.register({
      namespace: integ.namespace,
      client: wrapClient(pair.client, { close: () => pair.close() }),
      trusted: true,
      allowedTools: defs.map((d) => d.descriptor.name),
    });
  }
  return host;
}
