// SPDX-License-Identifier: Apache-2.0

/**
 * What a remote MCP server says about its integration: its tools (`tools/list`), its `serverInfo`
 * and its `instructions`, as a manifest proposal the editor merges. The MCP exchange goes through
 * the credential proxy (`proxyCall`) once a connection exists, so connection selection,
 * `authorized_uris`, the egress guard and the 401 refresh are the proxy's; this module only speaks
 * MCP over it. An unauthenticated integration (AFPS §7.2) has nothing to inject: its server is
 * reached directly, egress-guarded on every hop. Persists nothing.
 */

import type { Implementation, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  createMcpHttpClient,
  httpStatusOf,
  type AppstrateMcpClient,
} from "@appstrate/mcp-transport";
import { isVariableTemplate } from "@appstrate/afps-shared/connection-variables";
import { isUnauthenticatedIntegration } from "@appstrate/core/integration";
import { isIconImage } from "@appstrate/core/appearance";
import { PACKAGE_CONTENT_ENTRY } from "@appstrate/core/package-files";
import { getErrorMessage } from "@appstrate/core/errors";
import type { Actor } from "../lib/actor.ts";
import { ApiError, badGateway } from "../lib/errors.ts";
import { checkEgressUrl, egressFetchImpl, fetchWithin } from "../lib/egress-host-guard.ts";
import { readBodyUnder } from "../lib/capped-body.ts";
import { logger } from "../lib/logger.ts";
import { proxyProblem } from "../lib/proxy-status.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { trackAudit } from "./audit.ts";
import { recordConnectionCall, type ConnectionCall } from "./credential-proxy/call-journal.ts";
import { proxyCall, ProxyCallError } from "./credential-proxy/core.ts";
import type { ProxyReach } from "./integration-connections.ts";
import {
  readIntegrationManifestForRun,
  type ResolvedIntegrationVersion,
} from "./integration-service.ts";
import { downloadPackageFiles } from "./package-items/storage.ts";
import { getCredentialProxyLimits } from "./proxy-limits.ts";
import { fetchServerIcon, siteIconFetch } from "./integration-icon.ts";
import { serverIdentityFields } from "./integration-discovery.ts";

export interface ServerSyncProposal {
  manifest: Record<string, unknown>;
  iconSource: string | null;
  /** The server's `instructions`, for the editor to propose as `INTEGRATION.md`. */
  instructions: string | null;
  /** Every tool listed, in server order, for the editor to show and select from. */
  tools: DiscoveredTool[];
  warnings: { code: string; message: string }[];
}

export interface DiscoveredTool {
  name: string;
  title?: string;
  description?: string;
  /** The server's `readOnlyHint` annotation: an untrusted hint, it only pre-selects. */
  readOnly: boolean;
  /** The server's `destructiveHint` annotation: an untrusted hint, it forbids the pre-selection. */
  destructive: boolean;
}

/** The sync reads, and the proxy authorizes against, the draft its route lets a home writer edit. */
const DRAFT: ResolvedIntegrationVersion = { source: "draft", version: null };
const SYNC_TIMEOUT_MS = 20_000;
const MAX_TOOLS = 500;
/** Bounds a server answering `nextCursor` forever with empty pages. */
const MAX_PAGES = 20;
/** Per MCP exchange: a `tools/list` page is kilobytes, not the proxy's general ceiling (an operator cap below it wins). */
const MAX_EXCHANGE_BYTES = 2 * 1024 * 1024;
/** `instructions` is the server's free text, proposed as a file: bounded like one. */
const MAX_INSTRUCTIONS_BYTES = 32 * 1024;
const MAX_TOOL_TITLE_CHARS = 200;
const MAX_TOOL_DESCRIPTION_CHARS = 1024;

export async function syncIntegrationFromServer(input: {
  scope: SpaceScope;
  actor: Actor;
  packageId: string;
  connectionId?: string;
  reach: ProxyReach;
  /** Who called, as the call journal records it. */
  caller: Pick<ConnectionCall, "apiKeyId" | "authMethod" | "requestId">;
  /** The caller's request: its going away ends the sync. */
  signal?: AbortSignal;
}): Promise<ServerSyncProposal> {
  const { scope, packageId } = input;
  // The draft being edited, published or not: `proxyCall` authorizes the exchange against it too.
  const loaded = await readIntegrationManifestForRun(packageId, DRAFT);
  if (!loaded.ok) {
    throw new ApiError({
      status: 400,
      code: "invalid_draft_manifest",
      title: "Invalid Draft Manifest",
      detail: `Draft for '${packageId}' is invalid; fix the manifest before synchronizing.`,
    });
  }
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
      detail: `Integration '${packageId}' uses the SSE transport; only Streamable HTTP servers can be synchronized.`,
    });
  }
  if (isVariableTemplate(url)) {
    throw new ApiError({
      status: 422,
      code: "sync_url_templated",
      title: "Server URL Is Templated",
      detail: `Integration '${packageId}' chooses its server URL per connection; it cannot be synchronized.`,
    });
  }

  const unauthenticated = isUnauthenticatedIntegration(loaded.manifest);
  if (unauthenticated && !(await checkEgressUrl(url, { requireHttpsForUntrustedHost: true })).ok) {
    throw badGateway(`The MCP server at ${URL.parse(url)?.origin} is refused by the egress guard.`);
  }

  // One bound for the whole sync, the icon lookup included.
  const timeout = AbortSignal.timeout(SYNC_TIMEOUT_MS);
  const deadline = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const egressFetch = fetchWithin(egressFetchImpl(), deadline);
  const direct = (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const res = await egressFetch(target, init);
    const body = await readBodyUnder(res, MAX_EXCHANGE_BYTES);
    if (body === null) throw new Error("an MCP answer exceeds the synchronization's bound");
    return new Response(body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  const proxied = (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // The standalone GET stream carries server-initiated messages, which a list-and-close never reads.
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const method = init?.method ?? "POST";
    const href = target instanceof Request ? target.url : String(target);
    const started = Date.now();
    // Journaled as the proxy route does: once per exchange that may have sent the credential.
    const journal = (connectionId: string, outcome: string) =>
      void trackAudit(
        recordConnectionCall({
          ...input.caller,
          orgId: scope.orgId,
          spaceId: scope.spaceId,
          connectionId,
          integrationId: packageId,
          actor: input.actor,
          runId: null,
          method,
          target: href,
          outcome,
          durationMs: Date.now() - started,
        }),
      );
    let result;
    try {
      result = await proxyCall({
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        actor: input.actor,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        reach: input.reach,
        version: DRAFT,
        integrationId: packageId,
        method,
        target: href,
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: typeof init?.body === "string" ? init.body : null,
        // The SDK echoes the server's values (`Mcp-Session-Id`, `nextCursor`): never a placeholder.
        literalHeaders: true,
        maxResponseBytes: Math.min(
          MAX_EXCHANGE_BYTES,
          getCredentialProxyLimits().max_response_bytes,
        ),
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      });
    } catch (err) {
      if (err instanceof ProxyCallError && err.connectionId) journal(err.connectionId, err.code);
      throw err;
    }
    journal(result.connectionId, String(result.status));
    return new Response(result.body, { status: result.status, headers: result.headers });
  }) as typeof fetch;

  // Alongside the exchange; a storage fault surfaces as itself, not as an MCP failure.
  const hasDoc = draftHasIntegrationDoc(scope.orgId, packageId);
  hasDoc.catch(() => {});

  let client: AppstrateMcpClient | undefined;
  let exchanged;
  try {
    client = await createMcpHttpClient(url, {
      fetch: unauthenticated ? direct : proxied,
      signal: deadline,
      onWarning: (message, data) => logger.warn(message, { packageId, ...data }),
    });
    const { tools, truncated } = await listAllTools(client, deadline);
    exchanged = {
      tools,
      truncated,
      info: client.getServerVersion(),
      instructions: client.getInstructions(),
    };
  } catch (err) {
    throw syncFailure(err, packageId, url, unauthenticated);
  } finally {
    await client?.close().catch(() => {});
  }
  return proposalFromServer(
    {
      url,
      info: exchanged.info,
      // Never proposed over the package's own document.
      instructions: exchanged.instructions && (await hasDoc) ? undefined : exchanged.instructions,
      tools: exchanged.tools,
      truncated: exchanged.truncated,
    },
    // Best-effort: past the deadline it finds nothing.
    fetchWithin(siteIconFetch(), deadline),
  );
}

/** Whether the draft's stored tree holds an `INTEGRATION.md`, whatever its content. */
async function draftHasIntegrationDoc(orgId: string, packageId: string): Promise<boolean> {
  const path = PACKAGE_CONTENT_ENTRY.integration?.path;
  const files = await downloadPackageFiles("integrations", orgId, packageId, undefined, "org");
  return path !== undefined && files !== null && Object.hasOwn(files, path);
}

async function listAllTools(
  client: AppstrateMcpClient,
  signal: AbortSignal,
): Promise<{ tools: Tool[]; truncated: boolean }> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.listToolsPage({ ...(cursor ? { cursor } : {}), signal });
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
  /** Returns redirects unfollowed: the icon lookup judges each hop. */
  fetchImpl: typeof fetch,
): Promise<ServerSyncProposal> {
  const { info } = server;
  const tools = discoveredTools(server.tools);
  const names = tools.map((tool) => tool.name);
  const manifest: Record<string, unknown> = {
    // Discovering is not authorizing: an agent inherits only the tools the server marks read-only,
    // and never one it also marks destructive.
    default_tools: tools
      .filter((tool) => tool.readOnly && !tool.destructive)
      .map((tool) => tool.name),
    tools_policy: Object.fromEntries(names.map((name) => [name, {}])),
  };
  Object.assign(manifest, serverIdentityFields(info));

  const iconSource = await fetchServerIcon(server.url, info, fetchImpl);
  // Only an icon the manifest accepts as is; any other raster is the editor's to re-encode.
  if (iconSource && isIconImage(iconSource)) manifest.icon = iconSource;

  const warnings: ServerSyncProposal["warnings"] = [];
  if (server.truncated) {
    warnings.push({
      code: "tools_truncated",
      message: `The server lists more tools than are read (${MAX_TOOLS} tools over at most ${MAX_PAGES} pages): only the first ${names.length} are proposed.`,
    });
  }
  const instructions = capInstructions(server.instructions?.trim() ?? "");
  if (instructions.truncated) {
    warnings.push({
      code: "instructions_truncated",
      message: `The server's instructions exceed ${MAX_INSTRUCTIONS_BYTES / 1024} KiB: they are cut at the last line that fits.`,
    });
  }
  return { manifest, iconSource, instructions: instructions.text || null, tools, warnings };
}

/** One entry per tool name (the first listed wins), with its display text bounded. */
function discoveredTools(listed: Tool[]): DiscoveredTool[] {
  const byName = new Map<string, DiscoveredTool>();
  for (const tool of listed) {
    if (byName.has(tool.name)) continue;
    const title = capText(tool.title ?? tool.annotations?.title, MAX_TOOL_TITLE_CHARS);
    const description = capText(tool.description, MAX_TOOL_DESCRIPTION_CHARS);
    byName.set(tool.name, {
      name: tool.name,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true,
    });
  }
  return [...byName.values()];
}

/** Trimmed, at most `max` code points (an ellipsis marking a cut); empty when absent. */
function capText(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  const chars = [...text.trim()];
  if (chars.length <= max) return chars.join("");
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

/** At most {@link MAX_INSTRUCTIONS_BYTES} of UTF-8, cut after the last whole line that fits. */
function capInstructions(text: string): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_INSTRUCTIONS_BYTES) return { text, truncated: false };
  // A code point split at the cap decodes as U+FFFD: dropped.
  const head = new TextDecoder()
    .decode(bytes.subarray(0, MAX_INSTRUCTIONS_BYTES))
    .replace(/\uFFFD$/, "");
  const lineEnd = head.lastIndexOf("\n");
  return { text: (lineEnd > 0 ? head.slice(0, lineEnd) : head).trimEnd(), truncated: true };
}

const notConnected = (detail: string) =>
  new ApiError({
    status: 409,
    code: "integration_not_connected",
    title: "Integration Not Connected",
    detail,
  });

function syncFailure(
  err: unknown,
  packageId: string,
  url: string,
  unauthenticated: boolean,
): Error {
  // The proxy names its own `X-Connection-Id` header; this route takes the body's `connection_id`.
  if (err instanceof ApiError && err.code === "must_choose_connection") {
    const detail = `No single connection of '${packageId}' applies: name one in the request body's \`connection_id\`.`;
    return new ApiError({
      status: err.status,
      code: err.code,
      title: err.title,
      detail,
      ...(err.fieldErrors
        ? { errors: err.fieldErrors.map((item) => ({ ...item, message: detail })) }
        : {}),
    });
  }
  if (err instanceof ApiError) return err;
  if (err instanceof ProxyCallError) {
    return err.code === "credential_not_found"
      ? notConnected(err.message)
      : proxyProblem(err.code, err.message);
  }
  const origin = URL.parse(url)?.origin;
  logger.warn("integration server sync: MCP exchange failed", {
    packageId,
    origin,
    error: getErrorMessage(err),
  });
  const status = httpStatusOf(err);
  if ((status === 401 || status === 403) && unauthenticated) {
    // AFPS §7.2: a challenge makes the integration unavailable, never an ad hoc authorization.
    return badGateway(
      `The MCP server at ${origin} asks for a credential (HTTP ${status}), but the integration declares no authentication.`,
    );
  }
  if (status === 401 || status === 403) {
    return badGateway(
      `The MCP server at ${origin} refused the connection's credential (HTTP ${status}); reconnect the integration.`,
    );
  }
  return badGateway(`The MCP server at ${origin} could not be synchronized.`);
}
