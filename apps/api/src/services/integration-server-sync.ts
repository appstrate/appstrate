// SPDX-License-Identifier: Apache-2.0

/**
 * What a connected remote MCP server says about its integration once a connection exists: its
 * tools (`tools/list`), its `serverInfo` and its `instructions`, as a manifest proposal the editor
 * merges. The MCP exchange goes through the credential proxy (`proxyCall`), so connection
 * selection, `authorized_uris`, the egress guard and the 401 refresh are the proxy's; this module
 * only speaks MCP over it. Persists nothing.
 */

import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Implementation, Tool } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHttpClient, type AppstrateMcpClient } from "@appstrate/mcp-transport";
import { isIconImage } from "@appstrate/core/appearance";
import { getErrorMessage } from "@appstrate/core/errors";
import type { Actor } from "../lib/actor.ts";
import { ApiError, badGateway } from "../lib/errors.ts";
import { egressFetchImpl } from "../lib/egress-host-guard.ts";
import { logger } from "../lib/logger.ts";
import { proxyProblem } from "../lib/proxy-status.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { proxyCall, ProxyCallError } from "./credential-proxy/core.ts";
import type { ProxyReach } from "./integration-connections.ts";
import { readIntegrationManifestForProxy } from "./integration-service.ts";
import { fetchSiteIcon, rasterIcon } from "./integration-icon.ts";
import { getCredentialProxyLimits } from "./proxy-limits.ts";

export interface ServerSyncProposal {
  manifest: Record<string, unknown>;
  iconSource: string | null;
  /** The server's `instructions`, for the editor to propose as `INTEGRATION.md`. */
  instructions: string | null;
  provenance: Record<string, "detected">;
  warnings: { code: string; message: string }[];
}

const SYNC_TIMEOUT_MS = 20_000;
const MAX_TOOLS = 500;
/** Bounds a server answering `nextCursor` forever with empty pages. */
const MAX_PAGES = 50;
/** `serverInfo.icons` entries tried before the site's own icon. */
const MAX_SERVER_ICONS = 4;
const CLIENT_INFO = { name: "appstrate-mcp-client", version: "0.0.0" };

export async function syncIntegrationFromServer(input: {
  scope: SpaceScope;
  actor: Actor;
  packageId: string;
  connectionId?: string;
  reach: ProxyReach;
}): Promise<ServerSyncProposal> {
  const { scope, packageId } = input;
  // The published version: the one `proxyCall` authorizes the call against.
  const loaded = await readIntegrationManifestForProxy(packageId, scope.orgId, null);
  if (!loaded.ok) throw notConnected(`Integration '${packageId}' has no usable published version.`);
  const source = loaded.manifest.source;
  if (source?.kind !== "remote") {
    throw new ApiError({
      status: 422,
      code: "integration_not_remote",
      title: "Not a Remote Integration",
      detail: `Integration '${packageId}' is not backed by a remote MCP server.`,
    });
  }
  const { url, transport } = source.remote;
  if (transport === "sse") {
    throw new ApiError({
      status: 422,
      code: "sync_transport_unsupported",
      title: "Transport Not Supported",
      detail: `Integration '${packageId}' uses the SSE transport; only Streamable HTTP servers can be synchronised.`,
    });
  }

  const deadline = AbortSignal.timeout(SYNC_TIMEOUT_MS);
  const { max_response_bytes } = getCredentialProxyLimits();
  const proxied = (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // The standalone GET stream carries server-initiated messages, which a list-and-close never reads.
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const result = await proxyCall({
      orgId: scope.orgId,
      spaceId: scope.spaceId,
      actor: input.actor,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      reach: input.reach,
      integrationId: packageId,
      method: init?.method ?? "POST",
      target: target instanceof Request ? target.url : String(target),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: typeof init?.body === "string" ? init.body : null,
      maxResponseBytes: max_response_bytes,
      signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
    });
    return new Response(result.body, { status: result.status, headers: result.headers });
  }) as typeof fetch;

  let client: AppstrateMcpClient | undefined;
  try {
    client = await createMcpHttpClient(url, {
      fetch: proxied,
      signal: deadline,
      clientInfo: CLIENT_INFO,
    });
    const { tools, truncated } = await listAllTools(client, deadline);
    return await proposalFromServer(
      {
        url,
        info: client.getServerVersion(),
        instructions: client.client.getInstructions(),
        tools,
        truncated,
      },
      egressFetchImpl(),
    );
  } catch (err) {
    throw syncFailure(err, packageId, url);
  } finally {
    await client?.close().catch(() => {});
  }
}

async function listAllTools(
  client: AppstrateMcpClient,
  signal: AbortSignal,
): Promise<{ tools: Tool[]; truncated: boolean }> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.client.listTools(cursor ? { cursor } : undefined, { signal });
    tools.push(...res.tools);
    cursor = res.nextCursor;
    if (!cursor || tools.length >= MAX_TOOLS) break;
  }
  return { tools: tools.slice(0, MAX_TOOLS), truncated: tools.length > MAX_TOOLS || !!cursor };
}

/** The proposal a server's answers make. Exported for unit tests. */
export async function proposalFromServer(
  server: {
    url: string;
    info: Implementation | undefined;
    instructions: string | undefined;
    tools: Tool[];
    truncated: boolean;
  },
  fetchImpl: typeof fetch,
): Promise<ServerSyncProposal> {
  const { info } = server;
  const names = [...new Set(server.tools.map((tool) => tool.name))];
  const manifest: Record<string, unknown> = {
    default_tools: names,
    tools_policy: Object.fromEntries(names.map((name) => [name, {}])),
  };
  const displayName = info?.title?.trim() || info?.name?.trim();
  if (displayName) manifest.display_name = displayName;
  if (info?.description?.trim()) manifest.description = info.description.trim();
  const homepage = info?.websiteUrl ? URL.parse(info.websiteUrl) : null;
  if (homepage?.protocol === "https:" || homepage?.protocol === "http:") {
    manifest.homepage = homepage.href;
  }

  const iconSource = await serverIcon(server.url, info, fetchImpl);
  // Only an icon the manifest accepts as is; any other raster is the editor's to re-encode.
  if (iconSource && isIconImage(iconSource)) manifest.icon = iconSource;

  const provenance = Object.fromEntries(
    Object.keys(manifest).map((key) => [`/${key}`, "detected" as const]),
  );
  return {
    manifest,
    iconSource,
    instructions: server.instructions?.trim() || null,
    provenance,
    warnings: server.truncated
      ? [
          {
            code: "tools_truncated",
            message: `The server lists more than ${MAX_TOOLS} tools: only the first ${MAX_TOOLS} are proposed.`,
          },
        ]
      : [],
  };
}

/** A raster of `serverInfo.icons` (never SVG: `rasterIcon` sniffs the bytes), else the site's. */
async function serverIcon(
  url: string,
  info: Implementation | undefined,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  for (const icon of (info?.icons ?? []).slice(0, MAX_SERVER_ICONS)) {
    const raster = await rasterIcon(icon.src, fetchImpl);
    if (raster) return raster;
  }
  return fetchSiteIcon(url, fetchImpl);
}

const notConnected = (detail: string) =>
  new ApiError({
    status: 409,
    code: "integration_not_connected",
    title: "Integration Not Connected",
    detail,
  });

function syncFailure(err: unknown, packageId: string, url: string): Error {
  if (err instanceof ApiError) return err;
  if (err instanceof ProxyCallError) {
    return err.code === "credential_not_found"
      ? notConnected(err.message)
      : proxyProblem(err.code, err.message);
  }
  logger.warn("integration server sync: MCP exchange failed", {
    packageId,
    url,
    error: getErrorMessage(err),
  });
  if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) {
    return badGateway(
      `The MCP server at ${url} refused the connection's credential (HTTP ${err.code}); reconnect the integration.`,
    );
  }
  return badGateway(`The MCP server at ${url} could not be synchronised.`);
}
