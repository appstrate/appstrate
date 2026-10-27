// SPDX-License-Identifier: Apache-2.0

import type { AppstrateMcpClient } from "@appstrate/mcp-transport";

/** A live tool as the parity diff and the snapshot read it. */
export interface LiveTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Every tool the server lists (the client walks the pages, bounded, and throws past the cap). */
export async function listAllTools(appstrateClient: AppstrateMcpClient): Promise<LiveTool[]> {
  const { tools } = await appstrateClient.listTools();
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
  }));
}
