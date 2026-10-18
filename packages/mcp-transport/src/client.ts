// SPDX-License-Identifier: Apache-2.0

/**
 * MCP client factories for first-party callers.
 *
 * Two SDK lines, one client surface:
 *
 * - `createMcpHttpClient(...)` — Streamable HTTP, on the v2 client SDK
 *   (`@modelcontextprotocol/client`), which speaks BOTH protocol eras: it probes
 *   with `server/discover` (MCP 2026-07-28, stateless, version and identity in
 *   every request's `_meta`) and falls back to the `initialize` handshake of the
 *   2025 revisions when the server gives no modern evidence — the spec's
 *   backward-compatibility rules, applied by the SDK. Every consumer reaching an
 *   upstream MCP server over HTTP goes through it: the sidecar's remote
 *   integrations, the chat, the platform's server sync and discovery probe, and
 *   the agent's own hop to the sidecar.
 * - `wrapClient(...)` — the same surface over a connected v1 SDK `Client`
 *   (in-process pairs, stdio subprocesses, the deprecated HTTP+SSE transport):
 *   transports whose servers are 2025-era by construction.
 *
 * Cancellation is honored via `AbortSignal` on every call site.
 *
 * What this module deliberately does *not* do:
 *
 * - Implement reconnection logic. On transient errors the caller decides
 *   whether to retry.
 * - Implement auth. Credentials ride in the injected `fetch` (the credential
 *   proxy) or in static headers; the SDK is never given an auth provider.
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
import { readToolListPage, type ToolListPage } from "./tool-list.ts";
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

/**
 * Total cap on a `callTool` that requests progress. With progress the per-call
 * `timeout` is an idle timeout (it restarts on each notification), so nothing else
 * bounds a server that reports progress forever. The run deadline is the operative
 * bound; this is a backstop, far above the longest first-party progress call
 * (`ssh_exec`, 600 s). Independent of `APPSTRATE_MCP_TOOL_TIMEOUT_MS`.
 */
const MCP_PROGRESS_CALL_MAX_TOTAL_MS = 60 * 60_000;

/** How Appstrate names itself to an MCP server when its caller names nothing else. */
const DEFAULT_CLIENT_INFO: Implementation = {
  name: "appstrate-mcp-client",
  version: "0.0.0",
};

/**
 * How long a server found legacy is assumed to stay so. The spec asks a client to cache the era
 * per origin (`basic/versioning`, backward compatibility); a legacy verdict cannot expire on its
 * own (an upgraded dual-era server still answers `initialize`), so it is re-probed past this.
 */
const LEGACY_VERDICT_TTL_MS = 15 * 60_000;

/**
 * Origins found legacy: their next connect skips the `server/discover` probe. Only legacy
 * verdicts are kept — a modern connect probes anyway, `server/discover` being how it learns the
 * server's capabilities.
 */
const legacyOrigins = createCache<true>({
  name: "mcp-transport.legacy-origins",
  ttlMs: LEGACY_VERDICT_TTL_MS,
});

/** Forget every era verdict: each origin's next connect probes. For tests (`./testing`). */
export function forgetProtocolEras(): void {
  legacyOrigins.clear();
}

/**
 * Bound on the `server/discover` probe (or the caller's `defaultTimeoutMs`, when lower). Over HTTP the SDK reads a probe that times out as an
 * outage, not a legacy server, and would otherwise wait its 60 s default: past this the connect
 * tries the legacy handshake instead (see {@link connectOnce}).
 */
const ERA_PROBE_TIMEOUT_MS = 10_000;

/** The protocol a connection speaks: its era, and the revision negotiated when the SDK says. */
export interface McpProtocol {
  /** `modern`: 2026-07-28 and later, stateless. `legacy`: the 2025 `initialize` handshake. */
  era: "modern" | "legacy";
  version: string | undefined;
}

/** Options shared by every client factory in this module. */
export interface AppstrateMcpClientOptions {
  /** How the client names itself: in each request's `_meta` (modern) or in `initialize` (legacy). */
  clientInfo?: Implementation;
  /**
   * Per-call timeout in milliseconds. Defaults to 30s — matches the
   * sidecar's outbound upstream timeout. The SDK aborts the underlying
   * fetch if the timeout fires.
   */
  defaultTimeoutMs?: number;
}

/** Options for `createMcpHttpClient`. */
export interface McpHttpClientOptions extends AppstrateMcpClientOptions {
  /**
   * `auto` (default): negotiate the era. `legacy`: the 2025 `initialize` handshake straight
   * away, no probe — for a first-party server that is legacy by construction (the sidecar's
   * `/mcp`, the platform's MCP module, both on the v1 SDK).
   */
  era?: "auto" | "legacy";
  /**
   * Told what the client set aside on its own and the caller would not otherwise see: a tool
   * excluded from `tools/list` for an invalid `x-mcp-header` (SEP-2243). The SDK's own console
   * output is never reached; this is its replacement.
   */
  onWarning?: (message: string, data: Record<string, unknown>) => void;
  /** Per-run Bearer token. Sent as `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Optional `fetch` override (tests inject a mock). */
  fetch?: typeof fetch;
  /** Extra headers to merge into every request. */
  extraHeaders?: Record<string, string>;
  /**
   * Opt-in retry policy for the `client.connect(transport)` handshake.
   * When omitted the handshake is single-shot — callers
   * that race against an external boot sequence (runtime-pi waiting on
   * the sidecar's `/mcp`) opt in explicitly to avoid surprising other
   * call sites that want a fail-fast surface.
   */
  retry?: McpConnectRetryOptions;
  /**
   * Cancellation signal for the entire connect. Honoured on BOTH paths: it
   * short-circuits the retry loop *and* unwinds the in-flight era probe or
   * `initialize` handshake of every individual attempt (see
   * {@link connectWithSignal}) — including the single-shot path, which has no
   * loop to short-circuit.
   *
   * Independent from the retry deadline budget: `signal.abort()` is the
   * caller's own cancellation, the deadline triggers a separate AbortError.
   */
  signal?: AbortSignal;
}

/** Retry tuning for `createMcpHttpClient`'s initial connect. */
export interface McpConnectRetryOptions {
  /**
   * Hard wall-clock budget for the entire connect (including all retries
   * + final attempt). Defaults to 60s — wider than the sidecar's 30s
   * outbound upstream timeout because cold-start container pulls + boot
   * can routinely consume 20–45s. NOT operator-tunable — it is a
   * compiled constant in `runtime-pi/env.ts`. Making it a real knob means
   * adding the key to `SIDECAR_OPERATOR_ENV_KEYS`, not just reading it.
   */
  deadlineMs?: number;
  /**
   * Base delay for the exponential backoff. The actual delay for attempt
   * `n` (0-indexed) is `random(0, min(capMs, baseMs * 2^n))` — AWS-style
   * full jitter, which is the proven shape for thundering-herd avoidance
   * on a single dependency that crashes and recovers (e.g. sidecar boot).
   * See https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/.
   * Defaults to 50ms.
   */
  baseMs?: number;
  /**
   * Cap on the exponential growth — once `baseMs * 2^n` exceeds `capMs`,
   * the jitter window stays at `[0, capMs]`. Defaults to 1000ms.
   */
  capMs?: number;
  /**
   * Optional hook fired before each post-failure sleep. Receives the
   * structured retry context so callers can plug in their preferred
   * logger (the package itself never reaches for `console.*`).
   */
  onRetry?: (info: McpRetryAttemptInfo) => void;
}

/** Structured payload passed to `McpConnectRetryOptions.onRetry`. */
export interface McpRetryAttemptInfo {
  /** Final URL the connect was targeting (post-`new URL()` normalization). */
  url: string;
  /** 0-indexed attempt that just failed. The next attempt is `attempt + 1`. */
  attempt: number;
  /** Sleep window the loop is about to honour, in milliseconds. */
  delayMs: number;
  /** Best-effort Node-style error code surfaced from the error chain. */
  errorCode: string | undefined;
  /** The thrown error itself, for callers that want the full message. */
  error: unknown;
}

/**
 * The narrowed surface every consumer reads, whichever SDK line and protocol era is underneath:
 *
 *   1. Every call threads an `AbortSignal` (reuses the Pi `execute(_, _, signal)` contract —
 *      agents must be cancellable).
 *   2. The identity the client advertises is centralised here.
 *   3. A single `close()` tears down both client and transport.
 */
export interface AppstrateMcpClient {
  /**
   * Server capabilities: from `server/discover` (modern) or `initialize` (legacy). `undefined`
   * before the connect completes — callers check before branching on `tools` / `resources` /
   * `prompts` / `logging` support (the agent skips `resources/list` against a server that did
   * not advertise it).
   */
  getServerCapabilities(): ServerCapabilities | undefined;
  /**
   * The server's self-reported `Implementation` (`name`, `version`, and `title`, `icons`,
   * `websiteUrl` when it gives them). Required in a legacy `initialize` result, only a SHOULD
   * in a modern `server/discover`: an anonymous modern server leaves it `undefined`.
   */
  getServerVersion(): Implementation | undefined;
  /** The server's `instructions`, when it gives any. */
  getInstructions(): string | undefined;
  /** The era and revision the connection speaks; `undefined` before the connect completes. */
  getProtocol(): McpProtocol | undefined;
  /**
   * The server's tools. Over HTTP, every page (bounded by the SDK's page cap); over a v1
   * transport ({@link wrapClient}), the first page.
   */
  listTools(options?: { signal?: AbortSignal }): Promise<{ tools: Tool[] }>;
  /** One `tools/list` page: the first without `cursor`, else the page `cursor` names. */
  listToolsPage(options?: {
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<{ tools: Tool[]; nextCursor?: string }>;
  /** Invoke a tool by name. */
  callTool(
    args: { name: string; arguments?: Record<string, unknown> },
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      /** Requests progress; `timeoutMs` then restarts on each notification. */
      onProgress?: (progress: Progress) => void;
    },
  ): Promise<CallToolResult>;
  /** Read a resource by URI. */
  readResource(
    args: { uri: string },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ReadResourceResult>;
  /** Close the transport. Idempotent. */
  close(): Promise<void>;
}

/**
 * Connect a fresh MCP client to an HTTP server (Streamable HTTP), in whichever protocol era the
 * server speaks.
 *
 * Era negotiation is the SDK's `'auto'` mode: a `server/discover` probe carrying the 2026-07-28
 * `_meta` and `MCP-Protocol-Version` header; a result or a recognised modern error
 * (`UnsupportedProtocolVersion`, -32022, listing a version both sides speak — the client then
 * retries with it) keeps the connection modern and stateless; anything else falls back to the
 * legacy `initialize` handshake. A server found legacy is remembered per origin for
 * {@link LEGACY_VERDICT_TTL_MS}, so its next connects skip the probe; a connect that then fails
 * for any reason but an auth refusal re-probes once. A probe answered 5xx or not at all within
 * {@link ERA_PROBE_TIMEOUT_MS} falls back to the legacy handshake once. `era: "legacy"` skips the
 * probe for a server legacy by construction.
 *
 * Every request goes through `options.fetch` when given — the credential proxy is injected
 * there — and redirects are left to it (the SDK's own same-origin redirect policy is turned off:
 * the injected fetch owns that discipline, egress guard included).
 *
 * The transport uses the `Authorization: Bearer <token>` header when a
 * `bearerToken` is supplied. The server is expected to validate it with
 * a constant-time compare and respond `401` on miss — 401 is treated as
 * a fatal config error and bypasses retry even when retry is enabled.
 *
 * The returned client is **already connected**. On error, the partially-constructed transport is
 * cleaned up before the error propagates.
 *
 * When `options.retry` is set, connection-level failures (ECONNREFUSED,
 * ENOTFOUND, ECONNRESET, ETIMEDOUT, generic "fetch failed" with one of
 * those in `cause`, and SDK transport reset shapes) are retried with
 * AWS-style exponential backoff + full jitter inside the configured
 * deadline. Fatal errors (HTTP 4xx other than 408/429, TypeError, …)
 * still short-circuit on the first attempt.
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

  // Single-shot path — callers with their own retry harness around the factory, or none.
  if (!options.retry) return connectOnce(targetUrl, headers, options);
  return await connectWithRetry(targetUrl, headers, options, options.retry);
}

/**
 * One connect, era included.
 *
 * - A caller pinning `era: "legacy"` connects with the `initialize` handshake, no probe.
 * - An origin remembered legacy does too; when that connect fails for any reason but an auth
 *   refusal or the caller's abort, the verdict is dropped and the connect probes again, once.
 * - Otherwise the SDK probes. A probe answered 5xx, or unanswered within
 *   {@link ERA_PROBE_TIMEOUT_MS}, is no era evidence — the SDK reads it as an outage over HTTP —
 *   so the legacy handshake is tried once; if it fails too, its error is the one surfaced.
 */
async function connectOnce(
  targetUrl: URL,
  headers: Record<string, string>,
  options: McpHttpClientOptions,
): Promise<AppstrateMcpClient> {
  if (options.era === "legacy") return connectAttempt(targetUrl, headers, options, "legacy");
  const origin = targetUrl.origin;
  if (legacyOrigins.peek(origin)) {
    try {
      return await connectAttempt(targetUrl, headers, options, "legacy");
    } catch (err) {
      if (options.signal?.aborted || isAuthRefusal(err)) throw err;
      legacyOrigins.invalidate(origin);
      return await connectAttempt(targetUrl, headers, options, "auto");
    }
  }
  try {
    return await connectAttempt(targetUrl, headers, options, "auto");
  } catch (err) {
    if (!(err instanceof ProbeInconclusive) || options.signal?.aborted) throw err;
    return await connectAttempt(targetUrl, headers, options, "legacy");
  }
}

/** A probe that said nothing of the era (5xx, timeout): carries the SDK's error as `cause`. */
class ProbeInconclusive extends Error {
  constructor(cause: unknown) {
    super(`MCP era probe inconclusive: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

/** The JSON-RPC method of a POST body, when it is one request. */
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
  // The SDK wraps a fault of the era probe's request in an `SdkError` of its own; the fault the
  // injected fetch threw (a credential proxy's refusal, a socket error) is what the caller asked
  // for, so it is handed back as itself. The methods sent tell a failed probe from a failed
  // handshake.
  const baseFetch = options.fetch ?? fetch;
  const fetchFaults = new WeakSet<object>();
  let pastProbe = false;
  const observedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = postedMethod(init);
    if (method !== undefined && method !== "server/discover") pastProbe = true;
    try {
      return await baseFetch(input, init);
    } catch (err) {
      if (typeof err === "object" && err !== null) fetchFaults.add(err);
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
      // A caller's own per-call bound, when tighter, bounds the probe too.
      probe: { timeoutMs: Math.min(ERA_PROBE_TIMEOUT_MS, options.defaultTimeoutMs ?? Infinity) },
    },
  });
  try {
    await connectWithSignal(client, transport, options.signal, era === "legacy");
  } catch (err) {
    await transport.close().catch(() => {});
    const cause = err instanceof SdkError ? err.cause : undefined;
    if (typeof cause === "object" && cause !== null && fetchFaults.has(cause)) throw cause;
    if (era === "auto" && !pastProbe && isInconclusiveProbe(err)) throw new ProbeInconclusive(err);
    throw err;
  }
  if (client.getProtocolEra() === "legacy") {
    if (options.era !== "legacy") legacyOrigins.set(targetUrl.origin, true);
  } else if (legacyOrigins.peek(targetUrl.origin)) {
    legacyOrigins.invalidate(targetUrl.origin);
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

/**
 * The HTTP status an error of this client carries (a refused connect or call), from the SDK's
 * data or, failing that, its message; `undefined` for any other failure.
 */
export function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof SdkHttpError) return err.status;
  const msg = err instanceof Error ? err.message : String(err);
  const match = /\b(?:HTTP|status(?: code)?)[:\s]*(\d{3})\b/i.exec(msg);
  return match ? Number(match[1]) : undefined;
}

/**
 * `client.connect`, with the caller's signal actually attached.
 *
 * This is the ONLY cancellation seam a connect has, and it bounds the phases that wedge: the
 * `server/discover` probe and the legacy `initialize` request both take the connect options'
 * signal. A retry loop is not an alternative bound — it wraps attempts, it cannot interrupt one
 * — which is why the signal goes here rather than only around the loop.
 *
 * RESIDUAL, on purpose: on the legacy path `connect` awaits one more POST after `initialize`
 * settles — `notifications/initialized` — and the SDK passes that one no signal. An abort
 * landing in that window is not honoured and the connect resolves once the POST returns. It is a
 * single round trip against a server that has just proved it answers, so it is left alone
 * rather than papered over with a second timer. `client-connect-residual` in the tests pins it,
 * so this note cannot quietly become false.
 *
 * Without it a connect answers only to the SDK's 60 s default request timeout: a caller's own
 * deadline (a chat turn's stop button, a run's cancellation) does nothing for a full minute while
 * a wedged server sits on the handshake, and the caller cannot tell that it is waiting.
 */
async function connectWithSignal(
  client: DualEraClient,
  transport: StreamableHTTPClientTransport,
  signal: AbortSignal | undefined,
  knownLegacy: boolean,
): Promise<void> {
  await client.connect(transport, {
    ...(signal ? { signal } : {}),
    ...(knownLegacy ? { prior: { kind: "legacy" } } : {}),
  });
}

/**
 * Drive the retry loop for `createMcpHttpClient`. Kept private so the
 * single-shot fast path stays one allocation away from the pre-retry
 * behaviour and the retry policy is centralised in one place.
 *
 * Backoff shape: `random(0, min(capMs, baseMs * 2^attempt))` (AWS full
 * jitter). The constant-pressure shape (no minimum delay) keeps the
 * platform absorbing the warm-path race (~50-130ms pooled sidecar boot)
 * without paying a fixed retry tax on every healthy run.
 */
async function connectWithRetry(
  targetUrl: URL,
  headers: Record<string, string>,
  options: McpHttpClientOptions,
  retry: McpConnectRetryOptions,
): Promise<AppstrateMcpClient> {
  const deadlineMs = retry.deadlineMs ?? 60_000;
  const baseMs = retry.baseMs ?? 50;
  const capMs = retry.capMs ?? 1_000;
  const startedAt = Date.now();
  const deadlineAt = startedAt + deadlineMs;

  // Independent abort: caller signal short-circuits the loop; the
  // deadline timer raises a synthetic AbortError when the budget is
  // exhausted mid-sleep.
  const externalSignal = options.signal;

  let attempt = 0;
  let lastError: unknown;
  let lastErrorCode: string | undefined;

  while (true) {
    if (externalSignal?.aborted) {
      throw new DOMException("MCP connect aborted by caller signal", "AbortError");
    }

    try {
      // The caller's signal reaches each ATTEMPT, not just the sleep below: without it an abort
      // raised while one handshake is in flight waits out that handshake.
      // The deadline bounds the attempt in flight too, not only the sleeps between attempts.
      const budget = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
      const signal = externalSignal ? AbortSignal.any([externalSignal, budget]) : budget;
      return await connectOnce(targetUrl, headers, { ...options, signal });
    } catch (err) {
      if (!externalSignal?.aborted && Date.now() >= deadlineAt) {
        throw buildDeadlineExceededError(deadlineMs, err, extractErrorCode(err));
      }
      lastError = err;
      lastErrorCode = extractErrorCode(err);

      if (isFatalConnectError(err)) {
        throw err;
      }

      // Check deadline BEFORE sleeping so we don't burn budget on an
      // unreachable host that's still being retried.
      const now = Date.now();
      if (now >= deadlineAt) {
        throw buildDeadlineExceededError(deadlineMs, lastError, lastErrorCode);
      }

      // Full jitter: `random(0, min(cap, base * 2^attempt))`. Clamped to
      // the remaining deadline so the final attempt fires exactly at
      // (not after) the budget edge.
      const expCap = Math.min(capMs, baseMs * Math.pow(2, attempt));
      const remaining = deadlineAt - now;
      const delayMs = Math.min(Math.floor(Math.random() * expCap), remaining);

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

/**
 * Sleep for `ms` milliseconds, returning early on caller-signal abort or
 * when the deadline elapses (whichever fires first). Throws
 * `AbortError` for caller signal; the deadline path is handled by the
 * outer loop's `Date.now() >= deadlineAt` check after wake.
 */
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

/**
 * Surface a Node-style error code from anywhere in the error chain.
 * undici / Bun's fetch wraps the syscall error inside `err.cause` (or
 * deeper) and only exposes a generic `"fetch failed"` message at the
 * top — the retry policy needs the inner code to decide whether to
 * retry, so we walk the chain bounded by a safety depth.
 *
 * Also probes `AggregateError.errors[]` (modern fetch can surface DNS
 * lookup failures as an aggregate of `EAGAIN` + `EAI_AGAIN`), returning
 * the first retryable code found among aggregated children.
 */
function extractErrorCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  // FIFO queue: visit `.cause` chain in order, and aggregate children in
  // declaration order. Lets callers reason about "first matching code"
  // deterministically — the most-recent wrapper wins, not the deepest.
  const queue: unknown[] = [err];
  let visited = 0;
  while (queue.length > 0 && visited < 16) {
    const cur = queue.shift();
    visited += 1;
    if (cur == null || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    // The SDK's own errors carry a string `code` of their own (`ERA_NEGOTIATION_FAILED`,
    // …) and wrap the network error as `cause`: theirs never names the socket fault.
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
 * Connection-level error codes that warrant a retry. Two naming
 * conventions coexist in the JS ecosystem and we must accept both:
 *
 *   - **Node/undici** uses E-prefix UPPER_SNAKE_CASE (`ECONNREFUSED`,
 *     `ENOTFOUND`, …) — the canonical libuv-derived names.
 *   - **Bun's fetch** uses PascalCase (`ConnectionRefused`,
 *     `ConnectionTimeout`, `DNSNotFound`, …) — its own naming, not
 *     Node-compatible.
 *
 * Without the Bun aliases, `isFatalConnectError()` would classify
 * Bun-side `ConnectionRefused` as fatal (no recognized retryable code
 * + `TypeError` falls through) and bypass the retry loop entirely. The
 * agent container's MCP handshake against the still-booting sidecar
 * would then fail on the very first attempt instead of riding through
 * the warm-path race window (~50-200 ms).
 */
const RETRYABLE_CODES = new Set([
  // Node / undici
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  // Bun fetch (PascalCase, no E-prefix)
  "ConnectionRefused",
  "ConnectionReset",
  "ConnectionClosed",
  "ConnectionTimeout",
  "DNSNotFound",
  "DNSTimeout",
]);

/**
 * Decide whether an error from `client.connect()` is a permanent failure
 * (no retry) or a transient connection-level shape that should bounce.
 *
 * The SDK's `StreamableHTTPClientTransport` wraps HTTP responses, so a
 * 401/403/4xx surfaces as a thrown Error with the status code embedded
 * in the message. We match conservatively: anything with a non-retryable
 * HTTP code in the message is fatal; anything else without a recognised
 * retryable network code falls through to the "treat as fatal" branch
 * (e.g. TypeError from a malformed URL).
 */
function isFatalConnectError(err: unknown): boolean {
  // Abort always wins — caller has explicitly bailed.
  if (err instanceof DOMException && err.name === "AbortError") return true;

  // Look for a retryable network code FIRST — Bun/undici wrap socket
  // errors as `TypeError("fetch failed")` with the real code on
  // `err.cause.code`, so checking `instanceof TypeError` before the code
  // probe would short-circuit on legitimate network blips.
  const code = extractErrorCode(err);
  if (code && RETRYABLE_CODES.has(code)) return false;

  // TypeError without a retryable code in the chain = programmer error
  // (malformed URL, bad headers, …). Fatal.
  if (err instanceof TypeError) return true;

  // An HTTP answer: the SDK's `SdkHttpError` carries its status (a v1 error, the
  // message). 408 and 429 are retryable per RFC 9110 / common API conventions.
  const status = httpStatusOf(err);
  if (status !== undefined) {
    if (status === 408 || status === 429) return false;
    if (status >= 400 && status < 500) return true;
    if (status >= 500) return false;
  }

  const msg = err instanceof Error ? err.message : String(err);
  if (/\b(?:Unauthorized|Forbidden|401|403)\b/.test(msg)) return true;

  // Common SDK transport reset wording — retryable.
  if (/\b(?:fetch failed|Failed to connect|network|reset|socket hang up)\b/i.test(msg)) {
    return false;
  }

  // Default: unknown error shape → treat as fatal. Better to surface a
  // weird failure than to spin the retry loop on an unexpected error
  // class (the deadline would catch it but the noise isn't worth it).
  return true;
}

/**
 * Compose the terminal error thrown when the retry deadline is
 * exhausted. Carries the last underlying error so operators can
 * distinguish "sidecar never booted" (ECONNREFUSED) from "sidecar
 * crashed mid-handshake" (ECONNRESET) at a glance.
 */
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

/** The options a request takes on either SDK line, in their shared spelling. */
interface SessionRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  onprogress?: (progress: Progress) => void;
  resetTimeoutOnProgress?: boolean;
}

/**
 * What {@link buildClient} needs of a connected SDK client: the one seam between the v1 and v2
 * SDK lines. The result types are the v1 ones the package exports; the wire JSON is the same, the
 * v2 types only state it differently (`structuredContent: unknown`, the 2026-07-28 additions).
 */
interface SdkSession {
  capabilities(): ServerCapabilities | undefined;
  serverVersion(): Implementation | undefined;
  instructions(): string | undefined;
  protocol(): McpProtocol | undefined;
  listTools(options: SessionRequestOptions): Promise<{ tools: Tool[] }>;
  listToolsPage(
    cursor: string | undefined,
    options: SessionRequestOptions,
  ): Promise<{ tools: Tool[]; nextCursor?: string }>;
  callTool(
    args: { name: string; arguments?: Record<string, unknown> },
    options: SessionRequestOptions,
  ): Promise<CallToolResult>;
  readResource(args: { uri: string }, options: SessionRequestOptions): Promise<ReadResourceResult>;
  close(): Promise<void>;
}

/** Bounds a server answering `nextCursor` forever, as the SDK's own walk does. */
const MAX_TOOL_PAGES = 64;

/** A connected v2 (dual-era) client. */
function dualEraSession(
  client: DualEraClient,
  onWarning: McpHttpClientOptions["onWarning"],
): SdkSession {
  // The definitions listed, for `callTool`'s `x-mcp-header` mirroring and output validation: the
  // SDK reads them from its own `listTools()` cache otherwise, which this session never fills.
  const listed = new Map<string, Tool>();
  // Every page is a raw request: the SDK's `listTools()` answers `[]` without asking a server
  // that advertises no `tools` capability, as v1 never did.
  const page = async (cursor: string | undefined, options: SessionRequestOptions) => {
    // The SDK validates a spec method's result itself (an explicit schema does not bypass it):
    // a page without `tools` is its typed `INVALID_RESULT`, never a TypeError here.
    const raw = await client.request(
      { method: "tools/list", params: cursor ? { cursor } : {} },
      options,
    );
    const read: ToolListPage = readToolListPage(raw, client.getProtocolEra() === "modern");
    for (const { name, reason } of read.excluded) {
      onWarning?.(`MCP tool '${name}' excluded from tools/list: ${reason}`, { tool: name, reason });
    }
    for (const tool of read.tools) listed.set(tool.name, tool);
    return read;
  };
  return {
    capabilities: () => client.getServerCapabilities() as ServerCapabilities | undefined,
    serverVersion: () => client.getServerVersion() as Implementation | undefined,
    instructions: () => client.getInstructions(),
    protocol() {
      const era = client.getProtocolEra();
      return era ? { era, version: client.getNegotiatedProtocolVersion() } : undefined;
    },
    async listTools(options) {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      for (let n = 0; n < MAX_TOOL_PAGES; n++) {
        const read = await page(cursor, options);
        tools.push(...read.tools);
        if (read.nextCursor === undefined || read.nextCursor === cursor) return { tools };
        cursor = read.nextCursor;
      }
      throw new Error(`tools/list did not end within ${MAX_TOOL_PAGES} pages`);
    },
    async listToolsPage(cursor, options) {
      const read = await page(cursor, options);
      return { tools: read.tools, ...(read.nextCursor ? { nextCursor: read.nextCursor } : {}) };
    },
    async callTool(args, options) {
      const toolDefinition = listed.get(args.name);
      return (await client.callTool(args, {
        ...options,
        ...(toolDefinition ? { toolDefinition: toolDefinition as never } : {}),
      })) as CallToolResult;
    },
    async readResource(args, options) {
      return (await client.readResource(args, options)) as ReadResourceResult;
    },
    close: () => client.close(),
  };
}

/** A connected v1 client: a 2025-era server by construction. */
function legacySession(client: LegacyClient): SdkSession {
  return {
    capabilities: () => client.getServerCapabilities(),
    serverVersion: () => client.getServerVersion(),
    instructions: () => client.getInstructions(),
    protocol: () =>
      client.getServerCapabilities() ? { era: "legacy", version: undefined } : undefined,
    async listTools(options) {
      const result = await client.listTools(undefined, options);
      return { tools: result.tools };
    },
    async listToolsPage(cursor, options) {
      const page = await client.listTools(cursor ? { cursor } : undefined, options);
      return { tools: page.tools, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    async callTool(args, options) {
      return (await client.callTool(args, undefined, options)) as CallToolResult;
    },
    readResource: (args, options) => client.readResource(args, options),
    close: () => client.close(),
  };
}

/**
 * Wrap a connected v1 SDK `Client` (in-process pair, stdio subprocess, HTTP+SSE) in the
 * `AppstrateMcpClient` surface, with the cancellation and timeout semantics of the HTTP client.
 */
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
  // The v2 SDK answers a `tools/list` on a closed client with an empty list: a closed client
  // must fail its calls, never read as a server without tools.
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
      return session.listTools(signalOption(options?.signal));
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
