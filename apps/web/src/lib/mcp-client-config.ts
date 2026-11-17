// SPDX-License-Identifier: Apache-2.0

// Per-client connection snippets for an organization's MCP server. Any spec-compliant
// client (Streamable HTTP, OAuth 2.1 + DCR) connects with the URL alone; these all
// derive from the same two values.

interface McpClientConfig {
  serverName: string;
  url: string;
  claudeCodeCommand: string;
  httpJson: string;
  /** stdio bridge via `mcp-remote` for clients without native HTTP/OAuth. */
  mcpRemoteJson: string;
  cursorDeeplink: string;
  vscodeDeeplink: string;
}

function toBase64(value: string): string {
  // btoa throws on code points > U+00FF: encode to UTF-8 bytes first (non-ASCII server names).
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
