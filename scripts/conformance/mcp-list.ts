// SPDX-License-Identifier: Apache-2.0

/**
 * Fully-paginated `tools/list` for a connected MCP client, page by page so a
 * server cursoring forever stops at `maxPages` with an error instead of a
 * partial list — a partial list would make the tool-parity diff report phantom
 * "declared but not exposed" failures.
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
  const maxPages = options.maxPages ?? 50;
  const out: LiveTool[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const page = await appstrateClient.listToolsPage({
      ...(cursor ? { cursor } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
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
