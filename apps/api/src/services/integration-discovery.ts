// SPDX-License-Identifier: Apache-2.0

/**
 * What a remote MCP server URL says about the integration it would back: its
 * transport, its auth (an unauthenticated MCP connect, in whichever protocol era
 * the server speaks, then RFC 9728 → RFC 8414) and its identity (`server/discover`
 * or `initialize`, when the server answers either without a credential), as a
 * manifest proposal the editor merges. Persists nothing.
 * `provenance` marks each proposed field `detected` (the server published it)
 * or `guessed` (inferred), keyed by JSON pointer into the manifest.
 */

import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { parse as parseHost } from "tldts";
import { createMcpHttpClient, httpStatusOf } from "@appstrate/mcp-transport";
import {
  discoverProtectedResourceMetadata,
  parseResourceMetadataChallenge,
  parseScopeChallenge,
  resolveOAuthEndpoints,
  withOfflineAccess,
} from "@appstrate/connect";
import { isIconImage } from "@appstrate/core/appearance";
import { getErrorMessage } from "@appstrate/core/errors";
import { scopeTokenSchema } from "@appstrate/core/integration";
import { toSlug } from "@appstrate/core/naming";
import { parseSseFrames } from "@appstrate/core/sse";
import { ApiError, badGateway, invalidRequest } from "../lib/errors.ts";
import {
  checkEgressUrl,
  egressFetchImpl,
  fetchWithin,
  isBlockedEgressUrl,
} from "../lib/egress-host-guard.ts";
import { readBodyPrefix, readBodyUnder } from "../lib/capped-body.ts";
import { logger } from "../lib/logger.ts";
import { presentsClientMetadataDocument } from "../lib/integration-client-metadata.ts";
import { fetchServerIcon, siteIconFetch } from "./integration-icon.ts";

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
/** The SSE fallback reads the head of a stream that may never end. */
const PROBE_BODY_MAX_BYTES = 64 * 1024;
/** One MCP answer of the probe (`server/discover`, `initialize`, a first `tools/list` page). */
const PROBE_EXCHANGE_MAX_BYTES = 1024 * 1024;

/**
 * What the probe found: a server answering with a challenge wants a credential, one answering
 * without (`challenge` undefined) serves MCP openly.
 */
interface ProbedServer {
  transport: Transport;
  /** Whether the transport was seen answering, rather than guessed from the URL. */
  transportDetected: boolean;
  challenge: string | undefined;
  /** What the server says it is, when it answered `server/discover` or `initialize` openly. */
  identity: Implementation | undefined;
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

  const { challenge, ...server } = await probeServer(url, fetchImpl);
  const [auth, iconSource] = await Promise.all([
    // AFPS §7.2: an open server's integration declares no auths.
    challenge === undefined
      ? null
      : // The metadata lookups swallow their faults: one cut by the deadline must not read as absent.
        discoverAuth(url, challenge, fetchImpl).then((found) => {
          if (deadline.aborted) throw unreachable(url, deadline.reason);
          return found;
        }),
    // Best-effort: past the deadline it finds nothing.
    fetchServerIcon(url, server.identity, iconFetch),
  ]);

  const identity = serverIdentityFields(server.identity);
  const detectedName = server.identity?.title?.trim() || auth?.resourceName;
  const provenance: Record<string, Provenance> = {
    "/display_name": detectedName || identity.display_name ? "detected" : "guessed",
    // From the host, not `resource_name`: a server's label ("Notion MCP (Beta)") makes a poor id.
    "/name": "guessed",
    "/source/remote/transport": server.transportDetected ? "detected" : "guessed",
    ...(auth ? { [`/auths/${auth.key}`]: auth.provenance } : {}),
  };
  const manifest: Record<string, unknown> = {
    display_name: detectedName || identity.display_name || hostDisplayName(url),
    name: `@${input.orgSlug}/${toSlug(hostDisplayName(url))}`,
    source: { kind: "remote", remote: { url, transport: server.transport } },
    ...(auth ? { auths: { [auth.key]: auth.auth } } : {}),
  };
  if (identity.description) {
    manifest.description = identity.description;
    provenance["/description"] = "detected";
  }
  if (identity.homepage) {
    manifest.homepage = identity.homepage;
    provenance["/homepage"] = "detected";
  }
  if (auth?.documentation) {
    manifest.documentation = auth.documentation;
    provenance["/documentation"] = "detected";
  }
  if (auth?.policyUri) {
    manifest.privacy_policies = [auth.policyUri];
    provenance["/privacy_policies"] = "detected";
  }
  // Only an icon the manifest accepts as is; any other raster is the editor's to re-encode.
  if (iconSource && isIconImage(iconSource)) {
    manifest.icon = iconSource;
    provenance["/icon"] = "detected";
  }
  return { manifest, iconSource, provenance, warnings: auth?.warnings ?? [] };
}

/**
 * An unauthenticated connect through the MCP transport, which picks the era: `server/discover`
 * first (MCP 2026-07-28), the legacy `initialize` when the server gives no modern evidence. A
 * Bearer challenge on the way is a server wanting a credential. A server answering the connect
 * openly is read (its identity), then asked for its tools: a challenge there still makes it a
 * protected server, an answer an open one. A 404/405 to every POST falls back to the SSE
 * transport's GET, as the spec's backward compatibility asks.
 */
async function probeServer(url: string, fetchImpl: typeof fetch): Promise<ProbedServer> {
  const seen: ProbeObservation = {};
  const probeFetch = observingFetch(url, fetchImpl, seen);
  // A server refusing before it answers says nothing of its transport.
  const guessed = (): Transport =>
    new URL(url).pathname.endsWith("/sse") ? "sse" : "streamable-http";

  let client;
  try {
    client = await createMcpHttpClient(url, { fetch: probeFetch });
  } catch (err) {
    if (seen.challenge !== undefined) {
      return {
        transport: guessed(),
        transportDetected: false,
        challenge: seen.challenge,
        identity: undefined,
      };
    }
    if (seen.failure !== undefined) throw unreachable(url, seen.failure);
    // A handshake answer past the probe's bound could not be read: no verdict on the server.
    if (seen.oversized) throw unreachable(url, err);
    const status = httpStatusOf(err) ?? seen.status;
    if (status === 404 || status === 405) return probeSse(url, fetchImpl);
    // A server that could not answer (the probe, then `initialize`): not a verdict on it.
    if (status !== undefined && status >= 500) throw unreachable(url, err);
    throw notAnMcpServer(url);
  }
  try {
    const identity = client.getServerVersion();
    // The tools ask, judged by what it answers: a Bearer challenge is a protected server.
    let refusal: unknown;
    await client.listToolsPage().catch((err: unknown) => {
      refusal = err ?? new Error("tools/list failed");
    });
    if (seen.challenge !== undefined) {
      return {
        transport: "streamable-http",
        transportDetected: true,
        challenge: seen.challenge,
        identity,
      };
    }
    if (refusal !== undefined && !seen.oversized) {
      // The same reading as the connect's: a fault on the way is the server unreachable, a
      // 401/403 without a Bearer challenge not an MCP server asking for a credential, a 5xx
      // a server that could not answer.
      if (seen.failure !== undefined) throw unreachable(url, seen.failure);
      const status = seen.status;
      if (status === 401 || status === 403) throw notAnMcpServer(url);
      if (status !== undefined && status >= 500) throw unreachable(url, refusal);
    }
    // It listed its tools — or answered the ask, if past the probe's bound or with a JSON-RPC
    // error — without a credential: an open server.
    return {
      transport: "streamable-http",
      transportDetected: true,
      challenge: undefined,
      identity,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

interface ProbeObservation {
  /** The Bearer challenge of the last 401/403 offering one. */
  challenge?: string;
  /** The status of the last answer. */
  status?: number;
  /** The fault of the last exchange that failed (a request, or its body cut short). */
  failure?: unknown;
  /** The last answer exceeded the probe's bound: the server answered, at length. */
  oversized?: boolean;
}

/**
 * The probe's `fetch`: each POST bounded in time and size and its body read whole (an answer cut
 * short is the server's fault, recorded as such), what it says recorded; the SSE stream a legacy
 * connect opens by GET is answered 405 here, as a server without one would — a probe never reads
 * it.
 */
function observingFetch(
  url: string,
  fetchImpl: typeof fetch,
  seen: ProbeObservation,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const res = await fetchImpl(input, { ...init, signal });
      seen.status = res.status;
      const challenge = bearerChallenge(res);
      if (challenge !== undefined) seen.challenge = challenge;
      seen.failure = undefined;
      seen.oversized = false;
      const body = await readBodyUnder(res, PROBE_EXCHANGE_MAX_BYTES);
      if (body === null) {
        seen.oversized = true;
        throw new Error(`an MCP answer of ${originOf(url)} exceeds the probe's bound`);
      }
      return new Response(body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (err) {
      if (!seen.oversized) seen.failure = err;
      throw err;
    }
  }) as typeof fetch;
}

/** The deprecated HTTP+SSE transport: a GET opening a stream whose first event names the endpoint. */
async function probeSse(url: string, fetchImpl: typeof fetch): Promise<ProbedServer> {
  const sse = await reach(url, fetchImpl, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });
  const sseChallenge = bearerChallenge(sse);
  if (sseChallenge !== undefined) {
    await sse.body?.cancel();
    return {
      transport: "sse",
      transportDetected: true,
      challenge: sseChallenge,
      identity: undefined,
    };
  }
  if (sse.ok && sse.headers.get("content-type")?.includes("text/event-stream")) {
    const isEndpoint = (text: string) =>
      parseSseFrames(text, "").frames.some((frame) => frame.event === "endpoint");
    const head = await readOrFail(url, () => readBodyPrefix(sse, PROBE_BODY_MAX_BYTES, isEndpoint));
    if (isEndpoint(`${head}\n\n`)) {
      return {
        transport: "sse",
        transportDetected: true,
        challenge: undefined,
        identity: undefined,
      };
    }
  } else {
    await sse.body?.cancel().catch(() => {});
  }
  throw notAnMcpServer(url);
}

/**
 * The manifest fields a server's self-reported `Implementation` fills: its display name, its
 * description, its website as the homepage (http(s) only). Self-reported, so only a proposal.
 */
export function serverIdentityFields(info: Implementation | undefined): {
  display_name?: string;
  description?: string;
  homepage?: string;
} {
  const fields: { display_name?: string; description?: string; homepage?: string } = {};
  const displayName = info?.title?.trim() || info?.name?.trim();
  if (displayName) fields.display_name = displayName;
  if (info?.description?.trim()) fields.description = info.description.trim();
  const homepage = info?.websiteUrl ? URL.parse(info.websiteUrl) : null;
  if (homepage?.protocol === "https:" || homepage?.protocol === "http:") {
    fields.homepage = homepage.href;
  }
  return fields;
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

const notAnMcpServer = (url: string) =>
  new ApiError({
    status: 422,
    code: "not_an_mcp_server",
    title: "Not an MCP Server",
    detail: `The server at ${originOf(url)} did not answer as a Streamable HTTP or SSE MCP server.`,
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
    const scopes = withOfflineAccess(
      scopeTokens(challengeScopes ?? md.scopesSupported ?? []),
      endpoints.scopesSupported,
    );
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
      warnings: [
        ...(warning ? [warning] : []),
        ...(autoClient ? issWarnings(advertised, endpoints) : []),
      ],
      ...(md.resourceName ? { resourceName: md.resourceName } : {}),
      ...(md.resourceDocumentation ? { documentation: md.resourceDocumentation } : {}),
      ...(md.resourcePolicyUri ? { policyUri: md.resourcePolicyUri } : {}),
    };
  }

  const atOrigin = await resolveOAuthEndpoints({ issuer: origin, fetchImpl });
  if (provisionsClientItself(atOrigin)) {
    const scopes = withOfflineAccess(scopeTokens(challengeScopes ?? []), atOrigin.scopesSupported);
    return {
      key: "oauth",
      auth: oauth2Auth(origin, { issuer: origin, method: "none", scopes, catalog: scopes }),
      provenance: "guessed",
      warnings: issWarnings(origin, atOrigin),
    };
  }
  return { key: "primary", auth: apiKeyAuth(origin), provenance: "guessed", warnings: [] };
}

/** Connect refuses such a server for an integration it creates (`assertProvisionableServer`). */
function issWarnings(
  server: string,
  endpoints: { authorizationResponseIssParameterSupported?: boolean },
): { code: string; message: string }[] {
  return endpoints.authorizationResponseIssParameterSupported === true
    ? []
    : [
        {
          code: "authorization_server_iss_unsupported",
          message: `The authorization server ${server} does not support RFC 9207 issuer identification (authorization_response_iss_parameter_supported): an integration created from this server cannot connect.`,
        },
      ];
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
