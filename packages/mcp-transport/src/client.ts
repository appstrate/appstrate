// SPDX-License-Identifier: Apache-2.0

/**
 * MCP client factories for first-party callers.
 *
 * Two transports, one client surface. The wiring code in `runtime-pi`
 * branches on transport construction only — `listTools`, `callTool`,
 * `readResource`, and `close` are identical across both modes:
 *
 * - `createMcpHttpClient(...)` — Streamable HTTP against the sidecar's
 *   `/mcp` endpoint. Used inside the agent container.
 * - `createInProcessPair(...)` (already exported from `./index.ts`) —
 *   `InMemoryTransport` for CLI mode where the sidecar is in-process.
 *
 * Both return an `AppstrateMcpClient` carrying a connected SDK `Client`.
 * Cancellation is honored via `AbortSignal` on every call site — the SDK
 * propagates it as `notifications/cancelled` to the server.
 *
 * What this module deliberately does *not* do:
 *
 * - Implement reconnection logic. Stateless transport per request on the
 *   server side means the connection is cheap; on transient errors the
 *   caller decides whether to retry.
 * - Implement OAuth. Sidecar auth is per-run Bearer (constant-time
 *   compared on the server, opaque to the client).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CallToolResult,
  Implementation,
  ReadResourceResult,
  ServerCapabilities,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_CLIENT_INFO: Implementation = {
  name: "appstrate-mcp-client",
  version: "0.0.0",
};

/** Options shared by every client factory in this module. */
export interface AppstrateMcpClientOptions {
  /** Identification advertised to the server during `initialize`. */
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
  /** Per-run Bearer token. Sent as `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Optional `fetch` override (tests inject a mock). */
  fetch?: typeof fetch;
  /** Extra headers to merge into every request. */
  extraHeaders?: Record<string, string>;
  /**
   * Opt-in retry policy for the `client.connect(transport)` handshake.
   * When omitted the legacy single-shot behaviour is preserved — callers
   * that race against an external boot sequence (runtime-pi waiting on
   * the sidecar's `/mcp`) opt in explicitly to avoid surprising other
   * call sites that want a fail-fast surface.
   */
  retry?: McpConnectRetryOptions;
  /**
   * Cancellation signal for the entire connect (including all retries).
   * Independent from the deadline budget — `signal.abort()` short-circuits
   * the retry loop, while the deadline triggers a separate AbortError.
   */
  signal?: AbortSignal;
}

/** Retry tuning for `createMcpHttpClient`'s initial connect. */
export interface McpConnectRetryOptions {
  /**
   * Hard wall-clock budget for the entire connect (including all retries
   * + final attempt). Defaults to 60s — wider than the sidecar's 30s
   * outbound upstream timeout because cold-start container pulls + boot
   * can routinely consume 20–45s (issue #406). Operators can widen it on
   * slow registries via the `APPSTRATE_MCP_CONNECT_DEADLINE_MS` env var
   * wired in `runtime-pi/entrypoint.ts`.
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
 * The narrowed surface `runtime-pi` consumes. Wraps the SDK `Client` to:
 *
 *   1. Force every call to thread an `AbortSignal` (reuses the Pi
 *      `execute(_, _, signal)` contract — agents must be cancellable).
 *   2. Centralise the `Implementation` info advertised on `initialize`.
 *   3. Provide a single `close()` that tears down both client + transport.
 */
export interface AppstrateMcpClient {
  /** The connected SDK `Client`. Exposed for advanced use cases. */
  readonly client: Client;
  /**
   * Server capabilities snapshotted during the MCP `initialize`
   * handshake. Returns `undefined` if the client hasn't completed
   * `connect()` yet — callers must check before branching on
   * `tools` / `resources` / `prompts` / `logging` support.
   *
   * Phase 6 (#276): the agent uses this to skip `resources/list`
   * against servers that didn't advertise the capability instead of
   * paying for a round-trip + JSON-RPC error.
   */
  getServerCapabilities(): ServerCapabilities | undefined;
  /**
   * Server `Implementation` (`{ name, version }`) snapshotted during
   * `initialize`. Used by McpHost log lines so operators can audit
   * which upstream version is actually connected.
   */
  getServerVersion(): Implementation | undefined;
  /** List server-advertised tools. */
  listTools(options?: { signal?: AbortSignal }): Promise<{ tools: Tool[] }>;
  /** Invoke a tool by name. */
  callTool(
    args: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal; timeoutMs?: number },
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
 * Connect a fresh MCP client to an HTTP server (Streamable HTTP).
 *
 * The transport uses the `Authorization: Bearer <token>` header when a
 * `bearerToken` is supplied. The server is expected to validate it with
 * a constant-time compare and respond `401` on miss — 401 is treated as
 * a fatal config error and bypasses retry even when retry is enabled.
 *
 * The returned client is **already connected** (we await
 * `client.connect()`). On error, the partially-constructed transport is
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

  // Single-shot path — preserves the pre-retry behaviour for callers
  // that explicitly opt out (and keeps the contract narrow for callers
  // that have their own retry harness around the factory).
  if (!options.retry) {
    const transport = new StreamableHTTPClientTransport(targetUrl, {
      requestInit: { headers },
      ...(options.fetch ? { fetch: options.fetch as never } : {}),
    });
    const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO);
    try {
      await client.connect(transport);
    } catch (err) {
      await transport.close().catch(() => {});
      throw err;
    }
    return wrapClient(client, transport, options.defaultTimeoutMs);
  }

  return await connectWithRetry(targetUrl, headers, options, options.retry);
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
  // exhausted mid-sleep. Combined via a tiny composite so a single
  // listener registration covers both.
  const externalSignal = options.signal;

  let attempt = 0;
  let lastError: unknown;
  let lastErrorCode: string | undefined;

  while (true) {
    if (externalSignal?.aborted) {
      throw new DOMException("MCP connect aborted by caller signal", "AbortError");
    }

    const transport = new StreamableHTTPClientTransport(targetUrl, {
      requestInit: { headers },
      ...(options.fetch ? { fetch: options.fetch as never } : {}),
    });
    const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO);

    try {
      await client.connect(transport);
      return wrapClient(client, transport, options.defaultTimeoutMs);
    } catch (err) {
      await transport.close().catch(() => {});
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
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string") return c;
    const errs = (cur as { errors?: unknown }).errors;
    if (Array.isArray(errs)) {
      for (const child of errs) queue.push(child);
    }
    queue.push((cur as { cause?: unknown }).cause);
  }
  return undefined;
}

/** Connection-level error codes that warrant a retry. */
const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
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

  // SDK surfaces HTTP failures as `Error: ... HTTP <status> ...` or
  // similar. Sniff the message for fatal status codes. 408 and 429 are
  // retryable per RFC 9110 / common API conventions.
  const msg = err instanceof Error ? err.message : String(err);
  const statusMatch = /\b(?:HTTP|status(?: code)?)[:\s]*(\d{3})\b/i.exec(msg);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 408 || status === 429) return false;
    if (status >= 400 && status < 500) return true;
    if (status >= 500) return false;
  }

  // Generic "Error POSTing to endpoint (HTTP 401)" shape used by the
  // SDK — already matched above. Fall through.
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

/**
 * Wrap a connected SDK `Client` (regardless of transport) in the
 * `AppstrateMcpClient` surface. Used by both HTTP and in-memory
 * factories so cancellation + timeout semantics are identical.
 */
export function wrapClient(
  client: Client,
  transport: { close(): Promise<void> },
  defaultTimeoutMs?: number,
): AppstrateMcpClient {
  let closed = false;
  return {
    client,
    getServerCapabilities() {
      return client.getServerCapabilities();
    },
    getServerVersion() {
      return client.getServerVersion();
    },
    async listTools(options) {
      const result = await client.listTools(undefined, {
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return { tools: result.tools };
    },
    async callTool(args, options) {
      return client.callTool(args, undefined, {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...((options?.timeoutMs ?? defaultTimeoutMs)
          ? { timeout: options?.timeoutMs ?? defaultTimeoutMs }
          : {}),
      }) as Promise<CallToolResult>;
    },
    async readResource(args, options) {
      return client.readResource(args, {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...((options?.timeoutMs ?? defaultTimeoutMs)
          ? { timeout: options?.timeoutMs ?? defaultTimeoutMs }
          : {}),
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}
