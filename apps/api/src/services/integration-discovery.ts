// SPDX-License-Identifier: Apache-2.0

/**
 * What a remote MCP server URL says about the integration it would back: its
 * transport, its auth (an MCP `initialize` probe, then RFC 9728 → RFC 8414) and
 * its identity, as a manifest proposal the editor merges. Persists nothing.
 * `provenance` marks each proposed field `detected` (the server published it)
 * or `guessed` (inferred), keyed by JSON pointer into the manifest.
 */

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
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
import { ApiError, badGateway, invalidRequest } from "../lib/errors.ts";
import { checkEgressUrl, egressFetchImpl, isBlockedEgressUrl } from "../lib/egress-host-guard.ts";
import { readBodyPrefix } from "../lib/capped-body.ts";
import { logger } from "../lib/logger.ts";
import { fetchSiteIcon } from "./integration-icon.ts";

type Provenance = "detected" | "guessed";
type Transport = "streamable-http" | "sse";

export interface RemoteIntegrationProposal {
  manifest: Record<string, unknown>;
  iconSource: string | null;
  provenance: Record<string, Provenance>;
  warnings: { code: string; message: string }[];
}

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_BODY_MAX_BYTES = 64 * 1024;
const CLIENT_INFO = { name: "appstrate-mcp-client", version: "0.0.0" };

/** An MCP server that answered the probe with a challenge: it wants a credential. */
interface ProtectedServer {
  transport: Transport;
  challenge: string | null;
}

export async function discoverRemoteIntegration(
  input: { url: string; orgSlug: string },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<RemoteIntegrationProposal> {
  const { url } = input;
  const fetchImpl = deps.fetchImpl ?? egressFetchImpl();
  const egress = await checkEgressUrl(url, { requireHttpsForUntrustedHost: true });
  if (!egress.ok) {
    throw invalidRequest(
      egress.reason === "blocked-host"
        ? "The URL targets a private or reserved network address."
        : "The URL must be an https URL.",
      "url",
    );
  }

  const server = await probeServer(url, fetchImpl);
  const [auth, iconSource] = await Promise.all([
    discoverAuth(url, server.challenge, fetchImpl),
    fetchSiteIcon(url, fetchImpl),
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

/** POST `initialize` (Streamable HTTP); a 404/405 falls back to the SSE transport's GET. */
async function probeServer(url: string, fetchImpl: typeof fetch): Promise<ProtectedServer> {
  const res = await reach(url, fetchImpl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    }),
  });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    // A server refusing before `initialize` says nothing of its transport.
    const transport = new URL(url).pathname.endsWith("/sse") ? "sse" : "streamable-http";
    return { transport, challenge: res.headers.get("www-authenticate") };
  }
  if (res.ok) {
    const answered = isJsonRpcResponse(await readFirstMessage(res));
    const sessionId = res.headers.get("mcp-session-id");
    if (sessionId) {
      // Best-effort: end the session the probe opened.
      void fetchImpl(url, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sessionId },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    }
    throw answered ? authNotSupported(url) : notAnMcpServer(url);
  }
  await res.body?.cancel();
  if (res.status !== 404 && res.status !== 405) throw notAnMcpServer(url);

  const sse = await reach(url, fetchImpl, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });
  if (sse.status === 401 || sse.status === 403) {
    await sse.body?.cancel();
    return { transport: "sse", challenge: sse.headers.get("www-authenticate") };
  }
  if (sse.ok && sse.headers.get("content-type")?.includes("text/event-stream")) {
    const head = await readBodyPrefix(sse, PROBE_BODY_MAX_BYTES, endsEvent);
    if (/^event:\s*endpoint\s*$/m.test(head)) throw authNotSupported(url);
  } else {
    await sse.body?.cancel();
  }
  throw notAnMcpServer(url);
}

async function reach(url: string, fetchImpl: typeof fetch, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    logger.warn("integration discovery: server unreachable", { url, error: getErrorMessage(err) });
    throw badGateway(`The server at ${url} could not be reached.`);
  }
}

const endsEvent = (text: string) => /\r?\n\r?\n/.test(text);

/** The first JSON-RPC message of a JSON or SSE answer, or null. */
async function readFirstMessage(res: Response): Promise<unknown> {
  const isSse = res.headers.get("content-type")?.includes("text/event-stream") ?? false;
  const text = await readBodyPrefix(res, PROBE_BODY_MAX_BYTES, isSse ? endsEvent : undefined);
  const json = isSse
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
    : text;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
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
    detail: `The server at ${url} did not answer as a Streamable HTTP or SSE MCP server.`,
  });

const authNotSupported = (url: string) =>
  new ApiError({
    status: 422,
    code: "remote_mcp_auth_not_supported",
    title: "Unauthenticated MCP Server",
    detail: `The server at ${url} serves MCP without authentication, which integrations do not support yet.`,
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
 * authorization server at the URL's origin offering DCR → oauth2 (guessed);
 * else an API key sent as a Bearer token (guessed).
 */
async function discoverAuth(
  url: string,
  challenge: string | null,
  fetchImpl: typeof fetch,
): Promise<DiscoveredAuth> {
  const origin = new URL(url).origin;
  const resourceMetadataUrl = challenge ? parseResourceMetadataChallenge(challenge) : undefined;
  const challengeScopes = challenge ? parseScopeChallenge(challenge) : undefined;
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
    const autoClient = endpoints.registrationEndpoint !== undefined;
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
      warnings: autoClient
        ? []
        : [
            {
              code: "manual_client_required",
              message: `The authorization server ${advertised} offers no dynamic client registration: an administrator must register an OAuth client for this integration.`,
            },
          ],
      ...(md.resourceName ? { resourceName: md.resourceName } : {}),
      ...(md.resourceDocumentation ? { documentation: md.resourceDocumentation } : {}),
      ...(md.resourcePolicyUri ? { policyUri: md.resourcePolicyUri } : {}),
    };
  }

  const atOrigin = await resolveOAuthEndpoints({ issuer: origin, fetchImpl });
  if (atOrigin.registrationEndpoint) {
    const scopes = scopeTokens(challengeScopes ?? []);
    return {
      key: "oauth",
      auth: oauth2Auth(origin, { issuer: origin, method: "none", scopes, catalog: scopes }),
      provenance: "guessed",
      warnings: [],
    };
  }
  return { key: "api_key", auth: apiKeyAuth(origin), provenance: "guessed", warnings: [] };
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
        properties: { token: { type: "string", writeOnly: true, title: "Jeton d'API" } },
        required: ["token"],
      },
    },
    delivery: bearerDelivery("{$credential.token}"),
    _meta: { "dev.appstrate/auth": { required: true } },
  };
}

/** `mcp.notion.com` → `Notion`: the registrable label, capitalised. An IP stays as is. */
export function hostDisplayName(url: string): string {
  const { hostname } = new URL(url);
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return hostname;
  const labels = hostname.split(".");
  const label = labels.length >= 2 ? labels[labels.length - 2]! : labels[0]!;
  return label.charAt(0).toUpperCase() + label.slice(1);
}
