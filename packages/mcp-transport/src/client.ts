// SPDX-License-Identifier: Apache-2.0

/**
 * MCP client factories for first-party callers: one client surface over two SDK lines.
 *
 * - `createMcpHttpClient(...)`: Streamable HTTP on the v2 client SDK, which speaks both protocol
 *   eras (the mechanism: this package's README). Every consumer reaching an MCP server over HTTP
 *   goes through it.
 * - `wrapClient(...)`: the same surface over a connected v1 SDK `Client` (in-process pairs, stdio
 *   subprocesses, the deprecated HTTP+SSE transport), whose servers are 2025-era by construction.
 *
 * No reconnection logic (the caller decides whether to retry) and no auth: credentials ride in
 * the injected `fetch` (the credential proxy) or in static headers.
 */

import type { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import {
  Client as DualEraClient,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { createCache } from "@appstrate/core/cache";
import { readToolListPage } from "./tool-list.ts";
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Implementation,
  type Progress,
  type ReadResourceResult,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

/** Total cap on a progress call (its `timeout` is an idle one), far above `ssh_exec`'s 600 s. */
const MCP_PROGRESS_CALL_MAX_TOTAL_MS = 60 * 60_000;

const DEFAULT_CLIENT_INFO: Implementation = {
  name: "appstrate-mcp-client",
  version: "0.0.0",
};

/**
 * Origins found legacy: their next connect skips the probe. A legacy verdict cannot expire on its
 * own (an upgraded dual-era server still answers `initialize`), hence the TTL.
 */
const legacyOrigins = createCache<true>({
  name: "mcp-transport.legacy-origins",
  ttlMs: 15 * 60_000,
});

const isRememberedLegacy = (origin: string) => legacyOrigins.peek(origin) === true;

function forgetLegacy(origin: string): void {
  // `invalidate` broadcasts: not on every modern connect.
  if (isRememberedLegacy(origin)) legacyOrigins.invalidate(origin);
}

/** Forget every era verdict: each origin's next connect probes. For tests (`./testing`). */
export function forgetProtocolEras(): void {
  legacyOrigins.clear();
}

/** Bound on the era probe, which the SDK would otherwise let run its 60 s default. */
const ERA_PROBE_TIMEOUT_MS = 10_000;

export interface McpProtocol {
  /** `modern`: 2026-07-28 and later, stateless. `legacy`: the 2025 `initialize` handshake. */
  era: "modern" | "legacy";
  version: string | undefined;
}

export interface AppstrateMcpClientOptions {
  /** How the client names itself: in `_meta` (modern) or in `initialize` (legacy). */
  clientInfo?: Implementation;
  /** Per-call timeout in milliseconds; the SDK aborts the fetch when it fires. */
  defaultTimeoutMs?: number;
}

export interface McpHttpClientOptions extends AppstrateMcpClientOptions {
  /**
   * `auto` (default): negotiate the era. `legacy`: the `initialize` handshake, no probe, for a
   * first-party server legacy by construction (the sidecar's `/mcp`, the platform MCP module).
   */
  era?: "auto" | "legacy";
  /** Told of a tool excluded from `tools/list` for an invalid `x-mcp-header` (SEP-2243). */
  onWarning?: (message: string, data: Record<string, unknown>) => void;
  bearerToken?: string;
  fetch?: typeof fetch;
  extraHeaders?: Record<string, string>;
  /** Opt-in retry of the connect. Single-shot when omitted. */
  retry?: McpConnectRetryOptions;
  /** Cancels the whole connect, the attempt in flight included ({@link connectWithSignal}). */
  signal?: AbortSignal;
}

export interface McpConnectRetryOptions {
  /** Budget of the whole connect, retries included. 60s: a cold pull and boot take 20–45s. */
  deadlineMs?: number;
  /** Attempt `n` sleeps `random(0, min(capMs, baseMs * 2^n))` (full jitter). Default 50ms. */
  baseMs?: number;
  /** Default 1000ms. */
  capMs?: number;
  onRetry?: (info: McpRetryAttemptInfo) => void;
}

export interface McpRetryAttemptInfo {
  url: string;
  /** 0-indexed attempt that just failed. */
  attempt: number;
  delayMs: number;
  errorCode: string | undefined;
  error: unknown;
}

/** The surface every consumer reads, whichever SDK line and protocol era is underneath. */
export interface AppstrateMcpClient {
  getServerCapabilities(): ServerCapabilities | undefined;
  /** An anonymous modern server leaves it unset. */
  getServerVersion(): Implementation | undefined;
  getInstructions(): string | undefined;
  getProtocol(): McpProtocol | undefined;
  /** Every `tools/list` page; throws on a server still paginating past {@link MAX_TOOL_PAGES}. */
  listTools(options?: { signal?: AbortSignal }): Promise<{ tools: Tool[] }>;
  /** One `tools/list` page: the first without `cursor`, else the page `cursor` names. */
  listToolsPage(options?: {
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<{ tools: Tool[]; nextCursor?: string }>;
  callTool(
    args: { name: string; arguments?: Record<string, unknown> },
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      /** Requests progress; `timeoutMs` then restarts on each notification. */
      onProgress?: (progress: Progress) => void;
    },
  ): Promise<CallToolResult>;
  readResource(
    args: { uri: string },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ReadResourceResult>;
  close(): Promise<void>;
}

/**
 * Connect a fresh MCP client to a Streamable HTTP server, in whichever protocol era it speaks
 * (README, "createMcpHttpClient"). The returned client is already connected.
 *
 * Every request goes through `options.fetch` when given, redirects included: the injected fetch
 * owns that discipline, egress guard included. A 401 is a fatal config error, never retried.
 * With `options.retry`, connection-level failures (refused, reset, DNS, timeouts, 5xx, 408, 429)
 * are retried with full-jitter backoff inside the deadline; any other 4xx fails at once.
 */
export async function createMcpHttpClient(
  url: string | URL,
  options: McpHttpClientOptions = {},
): Promise<AppstrateMcpClient> {
  const targetUrl = url instanceof URL ? url : new URL(url);
  const headers: Record<string, string> = { ...(options.extraHeaders ?? {}) };
  if (options.bearerToken) {
    headers.Authorization = `Bearer ${options.bearerToken}`;
  }
  if (!options.retry) return connectOnce(targetUrl, headers, options);
  return await connectWithRetry(targetUrl, headers, options, options.retry);
}

/**
 * One connect, era included. An origin remembered legacy connects with `initialize`; only a 4xx
 * other than an auth refusal (the server stopped speaking it) drops the verdict and probes again.
 * An outage keeps the verdict and surfaces its own error: a re-probe would only wait it out twice.
 */
async function connectOnce(
  targetUrl: URL,
  headers: Record<string, string>,
  options: McpHttpClientOptions,
): Promise<AppstrateMcpClient> {
  if (options.era === "legacy") return connectAttempt(targetUrl, headers, options, "legacy");
  const origin = targetUrl.origin;
  if (isRememberedLegacy(origin)) {
    try {
      return await connectAttempt(targetUrl, headers, options, "legacy");
    } catch (err) {
      const status = httpStatusOf(err);
      const refused = status !== undefined && status >= 400 && status < 500;
      if (options.signal?.aborted || !refused || isAuthRefusal(err)) throw err;
      forgetLegacy(origin);
    }
  }
  return probeThenFallback(targetUrl, headers, options);
}

/**
 * The SDK's negotiation, then, when the probe said nothing of the era, the legacy handshake once.
 * Its error is surfaced only when it says something the probe did not (an auth refusal, a fault
 * of the injected fetch, a 5xx). A 4xx (a modern-only server refusing `initialize`) says the
 * probe's failure was the real one: a transient 5xx stays transient, for a retry loop to ride.
 */
async function probeThenFallback(
  targetUrl: URL,
  headers: Record<string, string>,
  options: McpHttpClientOptions,
): Promise<AppstrateMcpClient> {
  try {
    return await connectAttempt(targetUrl, headers, options, "auto");
  } catch (err) {
    if (!(err instanceof ProbeInconclusive) || options.signal?.aborted) throw err;
    try {
      const connected = await connectAttempt(targetUrl, headers, options, "legacy");
      legacyOrigins.set(targetUrl.origin, true);
      return connected;
    } catch (fallback) {
      if (options.signal?.aborted) throw fallback;
      const status = httpStatusOf(fallback);
      const telling =
        isAuthRefusal(fallback) ||
        isInjectedFetchFault(fallback) ||
        (status !== undefined && status >= 500);
      throw telling ? fallback : err.cause;
    }
  }
}

/** Errors the injected `fetch` threw: handed back as themselves, never re-read as an era signal. */
const injectedFetchFaults = new WeakSet<object>();
const isInjectedFetchFault = (err: unknown) =>
  typeof err === "object" && err !== null && injectedFetchFaults.has(err);

/** A probe that said nothing of the era (5xx, timeout): carries the SDK's error as `cause`. */
class ProbeInconclusive extends Error {
  constructor(cause: unknown) {
    super(`MCP era probe inconclusive: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

function postedMethod(init: RequestInit | undefined): string | undefined {
  if (typeof init?.body !== "string") return undefined;
  try {
    const method = (JSON.parse(init.body) as { method?: unknown }).method;
    return typeof method === "string" ? method : undefined;
  } catch {
    return undefined;
  }
}

async function connectAttempt(
  targetUrl: URL,
  headers: Record<string, string>,
  options: McpHttpClientOptions,
  era: "auto" | "legacy",
): Promise<AppstrateMcpClient> {
  // The SDK wraps a fault of the probe's request in an `SdkError`; the fault the injected fetch
  // threw (a credential proxy's refusal) is handed back as itself. The methods sent tell a failed
  // probe from a failed handshake.
  const baseFetch = options.fetch ?? fetch;
  let pastProbe = false;
  const observedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = postedMethod(init);
    if (method !== undefined && method !== "server/discover") pastProbe = true;
    try {
      return await baseFetch(input, init);
    } catch (err) {
      if (typeof err === "object" && err !== null) injectedFetchFaults.add(err);
      throw err;
    }
  }) as typeof fetch;
  const transport = new StreamableHTTPClientTransport(targetUrl, {
    requestInit: { headers },
    redirectPolicy: "follow",
    fetch: observedFetch,
  });
  const client = new DualEraClient(options.clientInfo ?? DEFAULT_CLIENT_INFO, {
    versionNegotiation: {
      mode: "auto",
      probe: { timeoutMs: Math.min(ERA_PROBE_TIMEOUT_MS, options.defaultTimeoutMs ?? Infinity) },
    },
  });
  try {
    await connectWithSignal(client, transport, options.signal, era === "legacy");
  } catch (err) {
    await transport.close().catch(() => {});
    if (options.signal?.aborted) throw abortReason(options.signal);
    const cause = err instanceof SdkError ? err.cause : undefined;
    if (isInjectedFetchFault(cause)) throw cause;
    if (era === "auto" && !pastProbe && isInconclusiveProbe(err)) throw new ProbeInconclusive(err);
    throw err;
  }
  // Only a probe sets the verdict: never renewed on the cached path (a busy origin would never
  // be re-probed), never set by a caller's pin.
  if (era === "auto") {
    if (client.getProtocolEra() === "legacy") legacyOrigins.set(targetUrl.origin, true);
    else forgetLegacy(targetUrl.origin);
  }
  return buildClient(
    dualEraSession(client, options.onWarning),
    transport,
    options.defaultTimeoutMs,
  );
}

/** A probe answered 5xx, or not at all in time. */
function isInconclusiveProbe(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status !== undefined) return status >= 500;
  return err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout;
}

/** A 401/403: the credential's verdict, which no other era would change. */
function isAuthRefusal(err: unknown): boolean {
  const status = httpStatusOf(err);
  return status === 401 || status === 403 || err instanceof UnauthorizedError;
}

/** The HTTP status a refused connect or call carries, from the SDK's data or its message. */
export function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof SdkHttpError) return err.status;
  const msg = err instanceof Error ? err.message : String(err);
  const match = /\b(?:HTTP|status(?: code)?)[:\s]*(\d{3})\b/i.exec(msg);
  return match ? Number(match[1]) : undefined;
}

/**
 * `client.connect` with the caller's signal attached: the only bound on a wedged handshake, which
 * a retry loop (wrapping attempts) cannot interrupt. The `initialize` request takes the signal;
 * the SDK builds the `server/discover` probe without it, so an abort also closes the transport.
 * An abort the SDK did not act on still fails the connect once it returns.
 *
 * RESIDUAL, on purpose: after `initialize` the SDK awaits `notifications/initialized` without a
 * signal, so an abort landing then fails the connect only once that one POST returns.
 * `client-connect-residual` in the tests pins it.
 */
async function connectWithSignal(
  client: DualEraClient,
  transport: StreamableHTTPClientTransport,
  signal: AbortSignal | undefined,
  knownLegacy: boolean,
): Promise<void> {
  signal?.throwIfAborted();
  const onAbort = () => void transport.close().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect(transport, {
      ...(signal ? { signal } : {}),
      ...(knownLegacy ? { prior: { kind: "legacy" } } : {}),
    });
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("MCP connect aborted", "AbortError");
}

/** No minimum delay: the sidecar boot race is absorbed without taxing every healthy run. */
async function connectWithRetry(
  targetUrl: URL,
  headers: Record<string, string>,
  options: McpHttpClientOptions,
  retry: McpConnectRetryOptions,
): Promise<AppstrateMcpClient> {
  const deadlineMs = retry.deadlineMs ?? 60_000;
  const baseMs = retry.baseMs ?? 50;
  const capMs = retry.capMs ?? 1_000;
  const deadlineAt = Date.now() + deadlineMs;
  const externalSignal = options.signal;
  // The deadline bounds the attempt in flight too, not only the sleeps between attempts.
  const budget = AbortSignal.timeout(deadlineMs);
  const attemptSignal = externalSignal ? AbortSignal.any([externalSignal, budget]) : budget;

  let attempt = 0;
  let lastError: unknown;
  let lastErrorCode: string | undefined;

  while (true) {
    if (externalSignal?.aborted) {
      throw new DOMException("MCP connect aborted by caller signal", "AbortError");
    }
    try {
      return await connectOnce(targetUrl, headers, { ...options, signal: attemptSignal });
    } catch (err) {
      if (!externalSignal?.aborted && (budget.aborted || Date.now() >= deadlineAt)) {
        // An attempt the budget cut says only that it was cut: the attempt before it says why.
        const last = budget.aborted && lastError !== undefined ? lastError : err;
        throw buildDeadlineExceededError(deadlineMs, last, extractErrorCode(last));
      }
      lastError = err;
      lastErrorCode = extractErrorCode(err);
      if (isFatalConnectError(err)) throw err;

      const now = Date.now();
      if (now >= deadlineAt) {
        throw buildDeadlineExceededError(deadlineMs, lastError, lastErrorCode);
      }
      // Clamped to the remaining deadline: the final attempt fires at, not after, its edge.
      const expCap = Math.min(capMs, baseMs * Math.pow(2, attempt));
      const delayMs = Math.min(Math.floor(Math.random() * expCap), deadlineAt - now);
      retry.onRetry?.({
        url: targetUrl.toString(),
        attempt,
        delayMs,
        errorCode: lastErrorCode,
        error: err,
      });
      await sleep(delayMs, externalSignal, deadlineAt);
      attempt += 1;
    }
  }
}

async function sleep(
  ms: number,
  signal: AbortSignal | undefined,
  deadlineAt: number,
): Promise<void> {
  const effective = Math.max(0, Math.min(ms, Math.max(0, deadlineAt - Date.now())));
  if (effective === 0) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, effective);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("MCP connect aborted by caller signal", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException("MCP connect aborted by caller signal", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** The first Node-style code in the chain (`cause`, `AggregateError.errors`), breadth-first. */
function extractErrorCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  let visited = 0;
  while (queue.length > 0 && visited < 16) {
    const cur = queue.shift();
    visited += 1;
    if (cur == null || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    // An SDK error's own `code` (`ERA_NEGOTIATION_FAILED`, …) never names the socket fault.
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string" && !(cur instanceof SdkError)) return c;
    const errs = (cur as { errors?: unknown }).errors;
    if (Array.isArray(errs)) {
      for (const child of errs) queue.push(child);
    }
    queue.push((cur as { cause?: unknown }).cause);
  }
  return undefined;
}

/**
 * Connection-level codes that warrant a retry, in both namings: Node/undici's and Bun fetch's
 * PascalCase. Without the Bun ones a refused connect to a still-booting sidecar would be fatal.
 */
const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ConnectionRefused",
  "ConnectionReset",
  "ConnectionClosed",
  "ConnectionTimeout",
  "DNSNotFound",
  "DNSTimeout",
]);

/** Whether a connect error is permanent (no retry); an unknown shape is, rather than spin. */
function isFatalConnectError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  // The code first: fetch wraps socket errors as `TypeError("fetch failed")`.
  const code = extractErrorCode(err);
  if (code && RETRYABLE_CODES.has(code)) return false;
  if (err instanceof TypeError) return true;

  const status = httpStatusOf(err);
  if (status !== undefined) {
    if (status === 408 || status === 429) return false;
    if (status >= 400 && status < 500) return true;
    if (status >= 500) return false;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b(?:Unauthorized|Forbidden|401|403)\b/.test(msg)) return true;
  if (/\b(?:fetch failed|Failed to connect|network|reset|socket hang up)\b/i.test(msg)) {
    return false;
  }
  return true;
}

function buildDeadlineExceededError(
  deadlineMs: number,
  lastError: unknown,
  lastErrorCode: string | undefined,
): Error {
  const lastMsg = lastError instanceof Error ? lastError.message : String(lastError);
  const codeHint = lastErrorCode ? ` ${lastErrorCode}` : "";
  const err = new Error(
    `MCP connect deadline exceeded after ${deadlineMs}ms (last error:${codeHint} ${lastMsg})`,
  );
  (err as { cause?: unknown }).cause = lastError;
  return err;
}

interface SessionRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  onprogress?: (progress: Progress) => void;
  resetTimeoutOnProgress?: boolean;
}

type ToolPage = { tools: Tool[]; nextCursor?: string };

/** The one seam between the v1 and v2 SDK lines; results in the v1 types the package exports. */
interface SdkSession {
  capabilities(): ServerCapabilities | undefined;
  serverVersion(): Implementation | undefined;
  instructions(): string | undefined;
  protocol(): McpProtocol | undefined;
  /** One page; its definitions join those the session validates calls against. */
  listToolsPage(cursor: string | undefined, options: SessionRequestOptions): Promise<ToolPage>;
  /** A complete listing: the definitions it carries replace the session's. */
  replaceTools(tools: Tool[]): void;
  callTool(
    args: { name: string; arguments?: Record<string, unknown> },
    options: SessionRequestOptions,
  ): Promise<CallToolResult>;
  readResource(args: { uri: string }, options: SessionRequestOptions): Promise<ReadResourceResult>;
  close(): Promise<void>;
}

const MAX_TOOL_PAGES = 64;

/** Every `tools/list` page, then the complete listing replaces the session's definitions. */
async function walkTools(
  session: SdkSession,
  options: SessionRequestOptions,
): Promise<{ tools: Tool[] }> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < MAX_TOOL_PAGES; n++) {
    const page = await session.listToolsPage(cursor, options);
    tools.push(...page.tools);
    if (page.nextCursor === undefined || page.nextCursor === cursor) {
      session.replaceTools(tools);
      return { tools };
    }
    cursor = page.nextCursor;
  }
  throw new Error(`tools/list did not end within ${MAX_TOOL_PAGES} pages`);
}

/** MCP 2026-07-28 `HeaderMismatch`. */
const HEADER_MISMATCH = -32020;

function dualEraSession(
  client: DualEraClient,
  onWarning: McpHttpClientOptions["onWarning"],
): SdkSession {
  // The definitions listed, handed to `callTool` for output validation (both eras) and
  // `x-mcp-header` mirroring (modern): the SDK's own `listTools()` cache stays empty, pages being
  // raw requests (that method answers `[]` to a server advertising no `tools` capability).
  let listed = new Map<string, Tool>();
  const session: SdkSession = {
    capabilities: () => client.getServerCapabilities() as ServerCapabilities | undefined,
    serverVersion: () => client.getServerVersion() as Implementation | undefined,
    instructions: () => client.getInstructions(),
    protocol() {
      const era = client.getProtocolEra();
      return era ? { era, version: client.getNegotiatedProtocolVersion() } : undefined;
    },
    async listToolsPage(cursor, options) {
      // A page without `tools` is the SDK's typed `INVALID_RESULT`, never a TypeError here.
      const raw = await client.request(
        { method: "tools/list", params: cursor ? { cursor } : {} },
        options,
      );
      const read = readToolListPage(raw, client.getProtocolEra() === "modern");
      for (const { name, reason } of read.excluded) {
        onWarning?.(`MCP tool '${name}' excluded from tools/list: ${reason}`, {
          tool: name,
          reason,
        });
      }
      for (const tool of read.tools) listed.set(tool.name, tool);
      return { tools: read.tools, ...(read.nextCursor ? { nextCursor: read.nextCursor } : {}) };
    },
    replaceTools(tools) {
      listed = new Map(tools.map((tool) => [tool.name, tool]));
    },
    async callTool(args, options) {
      const send = (toolDefinition: Tool | undefined) =>
        client.callTool(args, {
          ...options,
          ...(toolDefinition ? { toolDefinition: toolDefinition as never } : {}),
        }) as Promise<CallToolResult>;
      const definition = listed.get(args.name);
      try {
        return await send(definition);
      } catch (err) {
        // On a modern connection mirroring headers (SEP-2243), `HeaderMismatch` is the transport's
        // rejection before the tool runs: the definition is stale, so it is refreshed and the call
        // sent once more with it (never without, which would set the SDK's own resend going).
        // On a legacy one -32020 is the server's own code for a call that may have run.
        const modern = client.getProtocolEra() === "modern";
        if (
          !modern ||
          !definition ||
          (err as { code?: unknown } | null)?.code !== HEADER_MISMATCH
        ) {
          throw err;
        }
        try {
          await walkTools(session, {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.timeout ? { timeout: options.timeout } : {}),
          });
        } catch {
          throw err;
        }
        const refreshed = listed.get(args.name);
        if (!refreshed) throw err;
        return await send(refreshed);
      }
    },
    async readResource(args, options) {
      return (await client.readResource(args, options)) as ReadResourceResult;
    },
    close: () => client.close(),
  };
  return session;
}

function legacySession(client: LegacyClient): SdkSession {
  return {
    capabilities: () => client.getServerCapabilities(),
    serverVersion: () => client.getServerVersion(),
    instructions: () => client.getInstructions(),
    protocol: () =>
      client.getServerCapabilities() ? { era: "legacy", version: undefined } : undefined,
    async listToolsPage(cursor, options) {
      const page = await client.listTools(cursor ? { cursor } : undefined, options);
      return { tools: page.tools, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    replaceTools(tools) {
      // The v1 client validates `callTool` outputs against the validators of the last
      // `listTools()` response, one page: a walk re-caches them from every page.
      (client as unknown as { cacheToolMetadata(tools: Tool[]): void }).cacheToolMetadata(tools);
    },
    async callTool(args, options) {
      return (await client.callTool(args, undefined, options)) as CallToolResult;
    },
    readResource: (args, options) => client.readResource(args, options),
    close: () => client.close(),
  };
}

/** The client surface over a connected v1 SDK `Client` (in-process pair, stdio, HTTP+SSE). */
export function wrapClient(
  client: LegacyClient,
  transport: { close(): Promise<void> },
  defaultTimeoutMs?: number,
  maxTotalMs: number = MCP_PROGRESS_CALL_MAX_TOTAL_MS,
): AppstrateMcpClient {
  return buildClient(legacySession(client), transport, defaultTimeoutMs, maxTotalMs);
}

function buildClient(
  session: SdkSession,
  transport: { close(): Promise<void> },
  defaultTimeoutMs?: number,
  maxTotalMs: number = MCP_PROGRESS_CALL_MAX_TOTAL_MS,
): AppstrateMcpClient {
  let closed = false;
  const signalOption = (signal: AbortSignal | undefined) => (signal ? { signal } : {});
  // The v2 SDK answers a request on a closed client with an empty list: a closed client must
  // fail its calls, never read as a server without tools.
  const live = () => {
    if (closed) throw new Error("MCP client is closed");
  };
  return {
    getServerCapabilities: () => session.capabilities(),
    getServerVersion: () => session.serverVersion(),
    getInstructions: () => session.instructions(),
    getProtocol: () => session.protocol(),
    async listTools(options) {
      live();
      return walkTools(session, signalOption(options?.signal));
    },
    async listToolsPage(options) {
      live();
      return session.listToolsPage(options?.cursor, signalOption(options?.signal));
    },
    async callTool(args, options) {
      live();
      const timeout = options?.timeoutMs ?? defaultTimeoutMs;
      const timeoutOption = timeout ? { timeout } : {};
      if (!options?.onProgress) {
        return session.callTool(args, { ...signalOption(options?.signal), ...timeoutOption });
      }
      // With progress, `timeout` is an idle timeout: the total is capped by `maxTotalMs`
      // through the signal, so the SDK's cancel path tells the server (a
      // `notifications/cancelled`, or on a modern connection the closed response stream).
      // The v1 SDK's own `maxTotalTimeout` (1.32.1) rejects without telling the server.
      const total = new AbortController();
      const timer = setTimeout(
        () =>
          total.abort(
            new McpError(ErrorCode.RequestTimeout, "Maximum total timeout exceeded", {
              maxTotalTimeout: maxTotalMs,
            }),
          ),
        maxTotalMs,
      );
      (timer as { unref?: () => void }).unref?.();
      const signal = options.signal
        ? AbortSignal.any([options.signal, total.signal])
        : total.signal;
      try {
        return await session.callTool(args, {
          onprogress: options.onProgress,
          resetTimeoutOnProgress: true,
          signal,
          ...timeoutOption,
        });
      } finally {
        clearTimeout(timer);
      }
    },
    async readResource(args, options) {
      live();
      const timeout = options?.timeoutMs ?? defaultTimeoutMs;
      return session.readResource(args, {
        ...signalOption(options?.signal),
        ...(timeout ? { timeout } : {}),
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await session.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}
