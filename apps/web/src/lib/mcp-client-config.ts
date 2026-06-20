// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the per-client connection snippets for an organization's MCP server.
 *
 * The server speaks standard MCP Streamable HTTP with OAuth 2.1 + Dynamic
 * Client Registration (RFC 7591) and resource discovery (RFC 8707 / 9728), so
 * any spec-compliant client can connect with nothing more than the endpoint
 * URL. The richer per-client snippets below are convenience only — they all
 * derive from the same two values.
 */

export interface McpClientConfig {
  /** Logical server name used as the `mcpServers` key / CLI argument. */
  serverName: string;
  /** Raw Streamable HTTP endpoint — the lowest-common-denominator input. */
  url: string;
  /** `claude mcp add` one-liner (Claude Code CLI). */
  claudeCodeCommand: string;
  /** Generic `mcpServers` JSON block (Claude Desktop, Windsurf, Cline, …). */
  httpJson: string;
  /** stdio bridge via `mcp-remote` for clients without native HTTP/OAuth. */
  mcpRemoteJson: string;
  /** One-click Cursor deeplink (`cursor://…/mcp/install`). */
  cursorDeeplink: string;
  /** One-click VS Code deeplink (`vscode:mcp/install`). */
  vscodeDeeplink: string;
}

/** URL-safe base64 of an ASCII string (config snippets contain only ASCII). */
function toBase64(value: string): string {
  // btoa is safe here: server names and URLs are ASCII.
  return btoa(value);
}

export function buildMcpClientConfig(serverName: string, url: string): McpClientConfig {
  // Generic remote-server entry shared by every `mcpServers`-style client.
  const httpServerEntry = { type: "http", url };
  const httpJson = JSON.stringify({ mcpServers: { [serverName]: httpServerEntry } }, null, 2);

  // stdio fallback: wrap the remote server with the mcp-remote bridge.
  const mcpRemoteEntry = { command: "npx", args: ["-y", "mcp-remote", url] };
  const mcpRemoteJson = JSON.stringify({ mcpServers: { [serverName]: mcpRemoteEntry } }, null, 2);

  // Cursor expects ?name=<name>&config=<base64(serverEntry)>.
  const cursorDeeplink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(
    serverName,
  )}&config=${encodeURIComponent(toBase64(JSON.stringify(httpServerEntry)))}`;

  // VS Code expects a URL-encoded JSON object carrying the name inline.
  const vscodeDeeplink = `vscode:mcp/install?${encodeURIComponent(
    JSON.stringify({ name: serverName, ...httpServerEntry }),
  )}`;

  return {
    serverName,
    url,
    claudeCodeCommand: `claude mcp add --transport http ${serverName} ${url}`,
    httpJson,
    mcpRemoteJson,
    cursorDeeplink,
    vscodeDeeplink,
  };
}
