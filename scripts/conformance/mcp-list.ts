// SPDX-License-Identifier: Apache-2.0

/**
 * Fully-paginated `tools/list` for a connected MCP client.
 *
 * `AppstrateMcpClient.listTools()` issues a single request and drops
 * `nextCursor`, so a server with a large catalog that paginates would return
 * a partial list — which would make the tool-parity diff report phantom
 * "declared but not exposed" failures. This drives the raw SDK client through
 * the cursor loop so the harness always sees the complete tool set.
 */

import type { AppstrateMcpClient } from "@appstrate/mcp-transport";

export interface LiveTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Drive `tools/list` to exhaustion, following `nextCursor`. */
export async function listAllTools(
  appstrateClient: AppstrateMcpClient,
  options: { signal?: AbortSignal; maxPages?: number } = {},
): Promise<LiveTool[]> {
  const sdk = appstrateClient.client;
  const maxPages = options.maxPages ?? 50;
  const out: LiveTool[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const page = await sdk.listTools(
      cursor ? { cursor } : undefined,
      options.signal ? { signal: options.signal } : undefined,
    );
    for (const tool of page.tools) {
      out.push({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      });
    }
    cursor = page.nextCursor;
    pages++;
    if (pages >= maxPages) {
      // Safety stop — a server cursoring forever shouldn't hang the harness.
      throw new Error(`tools/list exceeded ${maxPages} pages — aborting pagination`);
    }
  } while (cursor);

  return out;
}
