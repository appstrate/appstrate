// SPDX-License-Identifier: Apache-2.0

/**
 * What a remote MCP server URL says about the integration it would back: its
 * transport, its auth (an MCP `initialize` probe, then RFC 9728 → RFC 8414) and
 * its identity, as a manifest proposal the editor merges. Persists nothing.
 * `provenance` marks each proposed field `detected` (the server published it)
 * or `guessed` (inferred), keyed by JSON pointer into the manifest.
 */

import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { parse as parseHost } from "tldts";
import { DEFAULT_CLIENT_INFO } from "@appstrate/mcp-transport";
import {
  discoverProtectedResourceMetadata,
  parseResourceMetadataChallenge,
  parseScopeChallenge,
  resolveOAuthEndpoints,
} from "@appstrate/connect";
import { isIconImage } from "@appstrate/core/appearance";
import { getErrorMessage } from "@appstrate/core/errors";
import { scopeTokenSchema } from "@appstrate/core/integration";
import { toSlug } from "@appstrate/core/naming";
import { parseSseFrames, parseSseJsonData } from "@appstrate/core/sse";
import { ApiError, badGateway, invalidRequest } from "../lib/errors.ts";
import {
  checkEgressUrl,
  egressFetchImpl,
  fetchWithin,
  isBlockedEgressUrl,
} from "../lib/egress-host-guard.ts";
import { readBodyPrefix } from "../lib/capped-body.ts";
import { logger } from "../lib/logger.ts";
import { presentsClientMetadataDocument } from "../lib/integration-client-metadata.ts";
import { fetchSiteIcon, siteIconFetch } from "./integration-icon.ts";

type Provenance = "detected" | "guessed";
type Transport = "streamable-http" | "sse";

export interface RemoteIntegrationProposal {
  manifest: Record<string, unknown>;
  iconSource: string | null;
  provenance: Record<string, Provenance>;
  warnings: { code: string; message: string }[];
}

const PROBE_TIMEOUT_MS = 10_000;
/** The whole discovery (probe, auth metadata, icon), each request keeping its own timeout. */
const DISCOVERY_TIMEOUT_MS = 25_000;
const PROBE_BODY_MAX_BYTES = 64 * 1024;
/** JSON-RPC codes of the 2026-07-28 revision's refusals (-32020 is defined there only). */
const HEADER_MISMATCH = -32020;
const METHOD_NOT_FOUND = -32601;

/** An MCP server that answered the probe with a challenge: it wants a credential. */
interface ProtectedServer {
  transport: Transport;
  challenge: string;
}

export async function discoverRemoteIntegration(
  input: { url: string; orgSlug: string },
  deps: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<RemoteIntegrationProposal> {
  const { url } = input;
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  // The caller's own bound (its request going away) ends the discovery too.
  const deadline = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  const fetchImpl = fetchWithin(deps.fetchImpl ?? egressFetchImpl(), deadline);
  // The icon lookup judges each redirect itself.
  const iconFetch = fetchWithin(deps.fetchImpl ?? siteIconFetch(), deadline);
  const egress = await checkEgressUrl(url, { requireHttpsForUntrustedHost: true });
  if (!egress.ok) {
    // The guard fails closed on a DNS fault: a typo'd host is not a private address.
    if (egress.detail === "resolution-failed") {
      throw invalidRequest("The host of the URL could not be resolved.", "url");
    }
    throw invalidRequest(
      egress.reason === "blocked-host"
        ? "The URL targets a private or reserved network address."
        : "The URL must be an https URL.",
      "url",
    );
  }

  const server = await probeServer(url, fetchImpl);
  const [auth, iconSource] = await Promise.all([
    // The metadata lookups swallow their faults: one cut by the deadline must not read as absent.
    discoverAuth(url, server.challenge, fetchImpl).then((found) => {
      if (deadline.aborted) throw unreachable(url, deadline.reason);
      return found;
    }),
    // Best-effort: past the deadline it finds nothing.
    fetchSiteIcon(url, iconFetch),
  ]);

  const displayName = auth.resourceName ?? hostDisplayName(url);
  const provenance: Record<string, Provenance> = {
    "/display_name": auth.resourceName ? "detected" : "guessed",
    // From the host, not `resource_name`: a server's label ("Notion MCP (Beta)") makes a poor id.
    "/name": "guessed",
    "/source/remote/transport": "guessed",
    [`/auths/${auth.key}`]: auth.provenance,
  };
  const manifest: Record<string, unknown> = {
    display_name: displayName,
    name: `@${input.orgSlug}/${toSlug(hostDisplayName(url))}`,
    source: { kind: "remote", remote: { url, transport: server.transport } },
    auths: { [auth.key]: auth.auth },
  };
  if (auth.documentation) {
    manifest.documentation = auth.documentation;
    provenance["/documentation"] = "detected";
  }
  if (auth.policyUri) {
    manifest.privacy_policies = [auth.policyUri];
    provenance["/privacy_policies"] = "detected";
  }
  // Only an icon the manifest accepts as is; any other raster is the editor's to re-encode.
  if (iconSource && isIconImage(iconSource)) {
    manifest.icon = iconSource;
    provenance["/icon"] = "detected";
  }
  return { manifest, iconSource, provenance, warnings: auth.warnings };
}

/**
 * POST `initialize` (Streamable HTTP); a 404/405 falls back to the SSE transport's GET. A
 * 2026-07-28 server refuses it with a JSON-RPC error (400, or 404 for an unknown method): read
 * before any fallback, as that revision's backward compatibility asks.
 */
async function probeServer(url: string, fetchImpl: typeof fetch): Promise<ProtectedServer> {
  const res = await reach(url, fetchImpl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      // A modern server reads it to answer a probe it refuses with a recognizable, versioned error.
      "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: DEFAULT_CLIENT_INFO,
      },
    }),
  });
  const challenge = bearerChallenge(res);
  if (challenge !== undefined) {
    await res.body?.cancel();
    // A server refusing before `initialize` says nothing of its transport.
    const transport = new URL(url).pathname.endsWith("/sse") ? "sse" : "streamable-http";
    return { transport, challenge };
  }
  if (res.ok) {
    const answered = await readOrFail(url, () => answersJsonRpc(res));
    throw answered ? authNotSupported(url) : notAnMcpServer(url);
  }
  if (res.status === 400 || res.status === 404 || res.status === 405) {
    // It refused on protocol grounds, past any credential check: an open MCP server. On a
    // 404/405 only a modern server's own error says so; a legacy server's generic JSON-RPC
    // body there still owes the SSE fallback its turn.
    const error = await readOrFail(url, () => jsonRpcError(res));
    if (error && (res.status === 400 || isModernError(error))) {
      throw modernOnly(url, error) ?? authNotSupported(url);
    }
  } else {
    await res.body?.cancel().catch(() => {});
  }
  if (res.status !== 404 && res.status !== 405) throw notAnMcpServer(url);

  const sse = await reach(url, fetchImpl, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });
  const sseChallenge = bearerChallenge(sse);
  if (sseChallenge !== undefined) {
    await sse.body?.cancel();
    return { transport: "sse", challenge: sseChallenge };
  }
  if (sse.ok && sse.headers.get("content-type")?.includes("text/event-stream")) {
    const isEndpoint = (text: string) =>
      parseSseFrames(text, "").frames.some((frame) => frame.event === "endpoint");
    const head = await readOrFail(url, () => readBodyPrefix(sse, PROBE_BODY_MAX_BYTES, isEndpoint));
    if (isEndpoint(`${head}\n\n`)) throw authNotSupported(url);
  } else {
    await sse.body?.cancel().catch(() => {});
  }
  throw notAnMcpServer(url);
}

/**
 * The `WWW-Authenticate` of a 401/403 offering the Bearer scheme (MCP authorization), else
 * undefined: any other refusal is not an MCP server asking for a credential.
 */
function bearerChallenge(res: Response): string | undefined {
  if (res.status !== 401 && res.status !== 403) return undefined;
  const challenge = res.headers.get("www-authenticate");
  return challenge && /(?:^|,)\s*Bearer(?:\s|,|$)/i.test(challenge) ? challenge : undefined;
}

async function reach(url: string, fetchImpl: typeof fetch, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    throw unreachable(url, err);
  }
}

/** A body read cut short (timeout, reset) is the server's fault, as a failed request is. */
async function readOrFail<T>(url: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throw unreachable(url, err);
  }
}

/** Logs and problem details name the origin only: a URL's path or query may carry a secret. */
const originOf = (url: string) => new URL(url).origin;

function unreachable(url: string, err: unknown): ApiError {
  const origin = originOf(url);
  logger.warn("integration discovery: server unreachable", { origin, error: getErrorMessage(err) });
  return badGateway(`The server at ${origin} could not be reached.`);
}

/** Whether a JSON or SSE answer carries a JSON-RPC response (notifications before it skipped). */
async function answersJsonRpc(res: Response): Promise<boolean> {
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    const head = await readBodyPrefix(res, PROBE_BODY_MAX_BYTES);
    const parsed = parseSseJsonData(head);
    // A body cut at the prefix does not parse: its head still says JSON-RPC 2.0.
    if (parsed === null) return /^\s*\{[\s\S]*?"jsonrpc"\s*:\s*"2\.0"/.test(head);
    return isJsonRpcResponse(parsed);
  }
  const answered = (text: string) =>
    parseSseFrames(text, "").frames.some((frame) =>
      isJsonRpcResponse(parseSseJsonData(frame.data)),
    );
  // A last frame the stream ended without its blank line still counts.
  return answered(`${await readBodyPrefix(res, PROBE_BODY_MAX_BYTES, answered)}\n\n`);
}

/** The `error` of a JSON-RPC error answer, else null. */
async function jsonRpcError(res: Response): Promise<Record<string, unknown> | null> {
  const parsed = parseSseJsonData(await readBodyPrefix(res, PROBE_BODY_MAX_BYTES));
  if (!isJsonRpcResponse(parsed)) return null;
  const { error } = parsed as { error?: unknown };
  return typeof error === "object" && error !== null ? (error as Record<string, unknown>) : null;
}

/** An error only a 2026-07-28 server gives a legacy probe: version list, header mismatch, unknown method. */
function isModernError(error: Record<string, unknown>): boolean {
  const data = error.data as { supported?: unknown } | null | undefined;
  return (
    Array.isArray(data?.supported) ||
    error.code === HEADER_MISMATCH ||
    error.code === METHOD_NOT_FOUND
  );
}

/** Whether the refusal means the server speaks only revisions this client does not. */
function modernOnly(url: string, error: Record<string, unknown>): ApiError | null {
  // HeaderMismatch exists only in 2026-07-28: the server took the probe as a modern request.
  if (error.code === HEADER_MISMATCH) {
    return new ApiError({
      status: 422,
      code: "remote_mcp_modern_only",
      title: "MCP Version Not Supported",
      detail: `The server at ${originOf(url)} serves only the stateless MCP revision (2026-07-28 or later); Appstrate speaks MCP up to ${LATEST_PROTOCOL_VERSION}.`,
    });
  }
  const supported = (error.data as { supported?: unknown } | null | undefined)?.supported;
  const versions = Array.isArray(supported)
    ? supported.filter((v): v is string => typeof v === "string")
    : [];
  if (versions.length === 0 || versions.some((v) => SUPPORTED_PROTOCOL_VERSIONS.includes(v))) {
    return null;
  }
  return new ApiError({
    status: 422,
    code: "remote_mcp_modern_only",
    title: "MCP Version Not Supported",
    detail: `The server at ${originOf(url)} serves only MCP ${versions.join(", ")}; Appstrate speaks MCP up to ${LATEST_PROTOCOL_VERSION}.`,
  });
}

function isJsonRpcResponse(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    ("result" in value || "error" in value)
  );
}

const notAnMcpServer = (url: string) =>
  new ApiError({
    status: 422,
    code: "not_an_mcp_server",
    title: "Not an MCP Server",
    detail: `The server at ${originOf(url)} did not answer as a Streamable HTTP or SSE MCP server.`,
  });

const authNotSupported = (url: string) =>
  new ApiError({
    status: 422,
    code: "remote_mcp_auth_not_supported",
    title: "Unauthenticated MCP Server",
    detail: `The server at ${originOf(url)} serves MCP without authentication, which integrations do not support yet.`,
  });

interface DiscoveredAuth {
  key: string;
  auth: Record<string, unknown>;
  provenance: Provenance;
  warnings: { code: string; message: string }[];
  resourceName?: string;
  documentation?: string;
  policyUri?: string;
}

/**
 * RFC 9728 metadata → an oauth2 auth on its authorization server. Without it, an
 * authorization server at the URL's origin provisioning a client by itself → oauth2 (guessed);
 * else an API key sent as a Bearer token (guessed), shaped as the editor's blank one.
 */
async function discoverAuth(
  url: string,
  challenge: string,
  fetchImpl: typeof fetch,
): Promise<DiscoveredAuth> {
  const origin = new URL(url).origin;
  const resourceMetadataUrl = parseResourceMetadataChallenge(challenge);
  const challengeScopes = parseScopeChallenge(challenge);
  const md = await discoverProtectedResourceMetadata({
    resourceServerUrl: url,
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    fetchImpl,
  });

  if (md) {
    const advertised = md.authorizationServers[0]!;
    const issuer = isBlockedEgressUrl(advertised) ? undefined : advertised;
    const endpoints = issuer ? await resolveOAuthEndpoints({ issuer, fetchImpl }) : {};
    const scopes = scopeTokens(challengeScopes ?? md.scopesSupported ?? []);
    const autoClient = provisionsClientItself(endpoints);
    const warning = !issuer
      ? {
          code: "authorization_server_blocked",
          message: `The authorization server ${advertised} is on a private or reserved network address: it was not read, and the integration cannot connect to it.`,
        }
      : autoClient
        ? null
        : {
            code: "manual_client_required",
            message: `The authorization server ${advertised} offers no client registration this instance can use (client metadata documents need a public https APP_URL; no dynamic client registration): an administrator must register an OAuth client for this integration.`,
          };
    return {
      key: "oauth",
      // A pre-registered client's connect resolves its endpoints from the issuer.
      auth: oauth2Auth(origin, {
        ...(autoClient || !issuer ? {} : { issuer }),
        method: autoClient ? "none" : "client_secret_post",
        scopes,
        catalog: scopeTokens([...scopes, ...(md.scopesSupported ?? [])]),
      }),
      provenance: "detected",
      warnings: warning ? [warning] : [],
      ...(md.resourceName ? { resourceName: md.resourceName } : {}),
      ...(md.resourceDocumentation ? { documentation: md.resourceDocumentation } : {}),
      ...(md.resourcePolicyUri ? { policyUri: md.resourcePolicyUri } : {}),
    };
  }

  const atOrigin = await resolveOAuthEndpoints({ issuer: origin, fetchImpl });
  if (provisionsClientItself(atOrigin)) {
    const scopes = scopeTokens(challengeScopes ?? []);
    return {
      key: "oauth",
      auth: oauth2Auth(origin, { issuer: origin, method: "none", scopes, catalog: scopes }),
      provenance: "guessed",
      warnings: [],
    };
  }
  return { key: "primary", auth: apiKeyAuth(origin), provenance: "guessed", warnings: [] };
}

/**
 * Whether connect can provision a public client at this server on its own: this instance's client
 * metadata document (when the server accepts one and the instance can serve it), else DCR — the
 * same two the connect path tries (`ensureIntegrationOAuthClient`).
 */
function provisionsClientItself(endpoints: {
  issuer?: string;
  clientIdMetadataDocumentSupported?: boolean;
  authorizationResponseIssParameterSupported?: boolean;
  registrationEndpoint?: string;
}): boolean {
  return presentsClientMetadataDocument(endpoints) || endpoints.registrationEndpoint !== undefined;
}

/** Distinct RFC 6749 §3.3 scope tokens; anything else is dropped. */
function scopeTokens(scopes: string[]): string[] {
  return [...new Set(scopes)].filter((scope) => scopeTokenSchema.safeParse(scope).success);
}

const bearerDelivery = (value: string) => ({
  http: { in: "header", name: "Authorization", prefix: "Bearer ", value },
});

function oauth2Auth(
  origin: string,
  opts: {
    issuer?: string;
    method: "none" | "client_secret_post";
    scopes: string[];
    catalog: string[];
  },
): Record<string, unknown> {
  return {
    type: "oauth2",
    ...(opts.issuer ? { issuer: opts.issuer } : {}),
    token_endpoint_auth_method: opts.method,
    default_scopes: opts.scopes,
    ...(opts.catalog.length > 0
      ? { scope_catalog: opts.catalog.map((value) => ({ value, label: value })) }
      : {}),
    authorized_uris: [`${origin}/**`],
    delivery: bearerDelivery("{$credential.access_token}"),
    _meta: {
      "dev.appstrate/oauth": { scope_separator: " " },
      "dev.appstrate/auth": { required: true },
    },
  };
}

function apiKeyAuth(origin: string): Record<string, unknown> {
  return {
    type: "api_key",
    authorized_uris: [`${origin}/**`],
    credentials: {
      schema: {
        type: "object",
        properties: {
          api_key: {
            type: "string",
            writeOnly: true,
          },
        },
        required: ["api_key"],
      },
    },
    delivery: bearerDelivery("{$credential.api_key}"),
    _meta: { "dev.appstrate/auth": { required: true } },
  };
}

/**
 * `mcp.notion.com` → `Notion`, `mcp.example.co.uk` → `Example`: the registrable domain's label
 * (Public Suffix List), capitalised. An IP stays as is.
 */
export function hostDisplayName(url: string): string {
  const { hostname } = new URL(url);
  const host = parseHost(hostname, { allowPrivateDomains: true, extractHostname: false });
  if (host.isIp) return hostname;
  const label = host.domainWithoutSuffix || hostname.split(".")[0]!;
  return label.charAt(0).toUpperCase() + label.slice(1);
}
