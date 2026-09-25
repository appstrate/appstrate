// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import pLimit, { type LimitFunction } from "p-limit";
import { mountMcp, validateMcpHostHeader } from "./mcp.ts";
import { RuntimeEventJournal } from "./runtime-event-journal.ts";
import type { ApiCallBaseDeps } from "./credential-proxy.ts";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { BlobStore } from "./blob-store.ts";
import { SIDECAR_AUTH_HEADER, type IntegrationBootReport } from "@appstrate/core/sidecar-types";
import {
  DEFAULT_API_CALL_CONCURRENCY,
  LLM_STREAM_IDLE_TIMEOUT_MS,
  MAX_REQUEST_BODY_SIZE,
  llmUpstreamAbort,
  readPositiveIntEnv,
  readRequestBodyBounded,
  withIdleBound,
  STREAM_IDLE,
  type SidecarConfig,
  type LlmProxyConfig,
  type LlmProxyOauthConfig,
  type LlmProxyPlatformConfig,
} from "./helpers.ts";
import { isBlockedEgressUrl } from "./ssrf.ts";
import {
  syntheticAliasErrorBody,
  isAliasInferenceCall,
  LLM_PASSTHROUGH_RESPONSE_HEADERS,
} from "./model-swap.ts";
import { handlePiMessagesRequest, type PiMessagesBackendDeps } from "./pi-messages-backend.ts";
import { applyOauthBearerSwap } from "@appstrate/core/oauth-bearer-swap";
import { forwardedLlmRequestHeaders } from "@appstrate/connect/llm-request-headers";
import {
  LLM_PROXY_ROUTES,
  RUN_LLM_PROXY_MOUNT,
  isProxiedApiShape,
  llmProxyBaseUrl,
} from "@appstrate/runner-pi/llm-proxy-routes";
import { llmProxyErrorBody } from "@appstrate/core/model-swap";
import {
  DEFAULT_INLINE_OUTPUT_TOKENS,
  DEFAULT_RUN_OUTPUT_BUDGET_TOKENS,
  TokenBudget,
  readPositiveTokenEnv,
} from "./token-budget.ts";
import { OAuthTokenCache, NeedsReconnectionError, type CachedToken } from "./oauth-token-cache.ts";
import { logger } from "./logger.ts";
import { filterSensitiveHeaders, scrubSecretMaterial, truncateForScrub } from "./redact.ts";

export type { SidecarConfig } from "./helpers.ts";

/**
 * The one route the agent-auth middleware below exempts. Kept as a constant so
 * the exemption is a single named fact rather than a string literal buried in a
 * conditional.
 */
const HEALTH_PATH = "/health";

/**
 * Constant-time check of an inbound {@link SIDECAR_AUTH_HEADER} against the
 * run's configured token.
 *
 * Fails closed on BOTH halves: an absent header and an unconfigured sidecar are
 * each a refusal. A sidecar with no token cannot tell the agent apart from the
 * integration runners sharing its network, so "no token configured" is exactly
 * the state in which it must answer nobody.
 *
 * The length check short-circuits before `timingSafeEqual` (which throws on
 * mismatched lengths). That leaks the token's LENGTH, which is a fixed
 * property of how the launcher mints it, not of its value.
 */
function isAuthorizedAgentRequest(
  presented: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * `Bun.serve` idle-timeout (seconds) applied to the sidecar's HTTP
 * surface. Bun's default of 10 s otherwise kills any LLM stream that
 * goes quiet longer than that (reasoning, parallel tool-call generation,
 * slow upstream) — see issue #426. 255 s is Bun's maximum allowed value
 * and sits under the 300 s run-tracker ceiling, so genuinely dead
 * connections still get reclaimed before the run is forcibly killed.
 * Imported by `server.ts` for the Bun.serve config.
 */
export const SIDECAR_IDLE_TIMEOUT_SECONDS = 255;

export interface AppDeps {
  config: SidecarConfig;
  cookieJar: Map<string, string[]>;
  fetchFn?: typeof fetch; // default: global fetch — injectable for tests
  isReady?: () => boolean; // default: () => true — controls /health
  /**
   * Inter-chunk idle bound applied to proxied `/llm/*` streams (both the raw
   * forward and the aliased `pi-messages` re-origination). Defaults to
   * {@link LLM_STREAM_IDLE_TIMEOUT_MS}, which is where the operator override
   * (`SIDECAR_LLM_STREAM_IDLE_TIMEOUT_MS`) is read; this injection point exists
   * only because the timeout path is otherwise untestable without a real
   * two-minute wait.
   */
  llmStreamIdleTimeoutMs?: number;
  /**
   * OAuth token cache. Required when the sidecar serves OAuth-mode LLM
   * configs (`config.llm.authMode === "oauth"`). Production server.ts
   * builds one against the platform API; tests pass a stub.
   */
  oauthTokenCache?: OAuthTokenCache;
  /**
   * Run identifier for the agent run this sidecar serves. Used to
   * scope the MCP blob cache — a single sidecar process serves a single
   * run, so the run id can be set once at boot. Defaults to `"unknown"`
   * for tests; production sets it via the platform on container create.
   */
  runId?: string;
  /**
   * Lazy provider for additional MCP tool definitions. Called on every
   * `/mcp` request so integrations that finish booting after the
   * sidecar's HTTP listener comes up still appear on the next call.
   * The integration runtime (Phase 1.4) wires `McpHost.buildTools` here.
   */
  additionalMcpToolsProvider?: () => AppstrateToolDefinition[];
  /**
   * Pre-built run-scoped runtime deps (blob store, token budget,
   * concurrency limiter, credential-proxy base deps). Production wires
   * these in `server.ts` and shares the SAME instances with
   * `bootIntegrations` so the in-process `api_call` MCP server and the
   * outer `/mcp` server's resource provider read the same blob store
   * (resource_link spillover resolves across the McpHost boundary).
   * Omitted by tests → `createApp` builds its own.
   */
  runtimeDeps?: SidecarRuntimeDeps;
  /**
   * Promise that resolves once `bootIntegrations` has finished its
   * initial pass. `tools/list` awaits this briefly (with a hard
   * timeout) so the agent's first call sees all declared integration
   * tools even though the sidecar's HTTP listener came up first.
   */
  integrationBootPromise?: Promise<void>;
  /**
   * Returns the integration boot report once {@link integrationBootPromise}
   * has resolved. Served by `GET /integrations/boot-report`, which the agent
   * polls after the MCP handshake to (a) emit the per-phase boot breadcrumbs
   * into the run log and (b) abort the run when `ok` is false. Omitted by
   * tests / sidecars launched without integrations.
   */
  integrationBootReportProvider?: () => IntegrationBootReport;
  /**
   * Per-run runtime-event journal. The runtime-tool defs (`server.ts`) are
   * wrapped to journal their canonical events on a single handler execution;
   * the `GET /runtime-events` endpoint serves them to whichever runner is
   * draining. Omitted by tests / sidecars without runtime tools → the endpoint
   * answers an empty batch.
   */
  runtimeEventJournal?: RuntimeEventJournal;
}

/**
 * Canonical casing for headers whose draft / standard spellings don't
 * match the naive Title-Case derivation. Generic Title-Casing turns
 * `ratelimit-limit` into `Ratelimit-Limit`, but the IETF RateLimit draft
 * (`draft-ietf-httpapi-ratelimit-headers`) and the Standard Webhooks
 * `X-RateLimit-*` family both use `RateLimit` as a single CamelCase token.
 * Some clients are case-sensitive on these — preserve the canonical form.
 */
const HEADER_CANONICAL_CASE: Record<string, string> = {
  "ratelimit-limit": "RateLimit-Limit",
  "ratelimit-remaining": "RateLimit-Remaining",
  "ratelimit-reset": "RateLimit-Reset",
  "ratelimit-policy": "RateLimit-Policy",
  "x-ratelimit-limit": "X-RateLimit-Limit",
  "x-ratelimit-remaining": "X-RateLimit-Remaining",
  "x-ratelimit-reset": "X-RateLimit-Reset",
};

/**
 * Per-call telemetry attached to `/llm/*` pass-throughs. Each observation
 * yields one info-level `llm.stream.observed` log on close (with TTFB,
 * max inter-chunk gap, total bytes) plus warn-level `llm.stream.error` /
 * `llm.stream.cancelled` on abnormal terminations. Added in #426 after a
 * silent 10 s Bun.serve idleTimeout was burning the 300 s run timeout in
 * a retry loop — keeping the closed-loop visibility avoids re-discovering
 * that class of bug from scratch.
 */
interface LlmStreamObservation {
  targetUrl?: string;
  credentialId?: string;
  authMode?: LlmProxyConfig["authMode"];
}

async function passUpstream(
  upstream: Response,
  observe?: LlmStreamObservation,
  idleTimeoutMs: number = LLM_STREAM_IDLE_TIMEOUT_MS,
): Promise<Response> {
  const responseHeaders: Record<string, string> = {};
  // Shared upstream-response header allowlist (content-type, retry/backoff,
  // x-request-id) — same posture as the platform LLM gateway; everything else
  // is dropped to keep the sidecar↔agent boundary tight.
  for (const name of LLM_PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      // Re-cased to preserve canonical HTTP form for the agent. Special-cased
      // headers (RateLimit family) come from the lookup table; everything else
      // falls back to a generic Title-Case transform.
      const canonical =
        HEADER_CANONICAL_CASE[name] ??
        name.replace(/(^|-)([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
      responseHeaders[canonical] = value;
    }
  }

  if (!upstream.body) {
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }

  const reader = upstream.body.getReader();
  const start = Date.now();
  let firstByteAt: number | null = null;
  let lastByteAt = start;
  let maxIdleMs = 0;
  let totalBytes = 0;
  let chunks = 0;

  const summary = (): Record<string, unknown> => ({
    ...observe,
    status: upstream.status,
    totalMs: Date.now() - start,
    ttfbMs: firstByteAt === null ? null : firstByteAt - start,
    maxIdleMs,
    bytes: totalBytes,
    chunks,
  });

  // `pull`-based: `reader.read()` is only invoked when the downstream
  // consumer (pi-ai) pulls a chunk. `maxIdleMs` therefore reflects the
  // time between consumer pulls — exactly what Bun.serve's idle watchdog
  // measures, and the reason a `>10 s` upstream pause was killing the
  // connection before #426. A separate eager reader would isolate raw
  // upstream byte timing, but we intentionally match what the serve
  // layer sees so the metric stays comparable to the idle-timeout
  // threshold.
  //
  // READ THE PARAGRAPH ABOVE BEFORE TOUCHING THE IDLE TIMEOUT BELOW. Because
  // this stream is `pull`-based, `maxIdleMs` is NOT upstream silence — it is
  // consumer latency. Arming a timeout on that counter, or on any timer that
  // keeps running while nobody is pulling, would kill a merely SLOW CONSUMER
  // on a perfectly healthy upstream. The correct instrument is the one used
  // in `withIdleBound`: race a timer against the PENDING `reader.read()`
  // promise, inside `pull`. That promise is pending exactly while the upstream
  // is silent AND the consumer is actually waiting for a chunk — the timer is
  // created when the read starts and cleared the moment it settles, so no
  // clock runs across a consumer-side pause. Do not "simplify" this into a
  // single long-lived timer; that is the bug, not the cleanup.
  const observed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const outcome = await withIdleBound(reader.read(), idleTimeoutMs);
        if (outcome === STREAM_IDLE) {
          // Not every api shape this platform maps honours pi-ai's own
          // `timeoutMs` (`pi-messages` ignores it), so this proxy is the only
          // provider-agnostic place a stalled stream can be caught. Without it
          // the run just burns its wall-clock budget and dies with no error.
          //
          // THIS MESSAGE IS FOR OUR LOG, not for the agent: `controller.error`
          // on a response body does not cross the HTTP hop. Over a real socket
          // the in-container client observes a TRUNCATED stream — `{done:true}`
          // — and the Error is discarded here. (In-process, as the tests drive
          // it through Hono's `app.request`, it does surface; that is the test
          // harness, not production.)
          //
          // The agent still gets a RETRYABLE failure, from the truncation
          // rather than from this text: pi-ai's adapters throw on a premature
          // end — `openai-completions.js` "Stream ended without finish_reason"
          // (whenever `compat.supportsFinishReason`, its default),
          // `anthropic-messages.js` "Anthropic stream ended before
          // message_stop" — and those strings match
          // `RETRYABLE_PROVIDER_ERROR_PATTERN` (`dist/utils/retry.js`:
          // `ended without`, `stream ended before message_stop`). So the
          // wording below is free to change; keep it operator-legible.
          const err = new Error(
            `LLM upstream stream timed out: no data received for ${idleTimeoutMs}ms`,
          );
          logger.warn("llm.stream.idle_timeout", { ...summary(), idleTimeoutMs });
          // Release the upstream socket before erroring the consumer branch;
          // swallow the cancel rejection so teardown can't escape as an
          // unhandled rejection on the sidecar process.
          void reader.cancel(err).catch(() => {});
          controller.error(err);
          return;
        }
        const { value, done } = outcome;
        const now = Date.now();
        const gap = now - lastByteAt;
        if (gap > maxIdleMs) maxIdleMs = gap;
        if (done) {
          logger.info("llm.stream.observed", summary());
          controller.close();
          return;
        }
        if (firstByteAt === null) firstByteAt = now;
        lastByteAt = now;
        totalBytes += value.byteLength;
        chunks += 1;
        controller.enqueue(value);
      } catch (err) {
        logger.warn("llm.stream.error", {
          ...summary(),
          error: err instanceof Error ? err.message : String(err),
        });
        controller.error(err);
      }
    },
    cancel(reason) {
      logger.warn("llm.stream.cancelled", { ...summary(), reason: String(reason ?? "") });
      return reader.cancel(reason);
    },
  });

  return new Response(observed, { status: upstream.status, headers: responseHeaders });
}

/** Chars of the upstream body kept in the operator log. */
const BODY_SAMPLE_MAX_CHARS = 200;
/**
 * Extra chars handed to the scrubber beyond the preview.
 *
 * The slice must happen BEFORE the scrub, not after. The body is
 * upstream-controlled and unbounded, this sidecar is single-threaded, and
 * `scrubSecretMaterial` is a pass of ~10 global regexes: scrubbing a 1 MB
 * error body to produce a 200-char log line blocked the event loop for 2.5 s
 * (measured, adversarial body) where the slice-first form costs ~0.05 ms.
 * `scrubStderrLine` in `integrations-boot.ts` is the sibling that already gets
 * this right.
 *
 * The margin covers the rules that match a credential from its START: cutting
 * at exactly the preview length would still mask the visible prefix of a
 * straddling token, EXCEPT where a rule carries a minimum length (`AKIA` + 12,
 * `eyJ` + 10) that the cut takes it below. 64 chars clears every such minimum.
 *
 * It does NOT cover the two rules that need a TERMINATOR — the userinfo pair,
 * which must see the `@`/`%40` before it can match anything. No margin can:
 * raising it moves the cut, it does not remove one. That case is closed by
 * `truncateForScrub`, which masks an authority the cut left unterminated; see
 * its docstring. The margin is therefore sized for the minimum-length rules
 * alone, which is all it was ever able to promise.
 */
const BODY_SAMPLE_SCRUB_MARGIN = 64;

/**
 * On non-2xx upstream responses, clone the body for the operator-facing
 * warn log (the agent still consumes the original stream). 2xx is silent —
 * normal traffic shouldn't pollute the log. Returns the original response.
 */
async function logOauthLlmResponse(
  credentialId: string,
  targetUrl: string,
  method: string,
  upstream: Response,
): Promise<Response> {
  if (upstream.status >= 200 && upstream.status < 300) return upstream;
  let bodySample = "";
  try {
    bodySample = await upstream.clone().text();
  } catch {
    // body unreadable — log what we have
  }
  // Drop credential-bearing headers (set-cookie, www-authenticate, …)
  // before the response hits the operator log. A 200-char preview is enough
  // to diagnose. Upstream JSON error payloads don't echo bearer tokens, but
  // we still scrub bearer/api-key patterns from the sample so the no-leak
  // guarantee holds independent of upstream behavior.
  const responseHeaders = filterSensitiveHeaders(upstream.headers);
  const scrubbed = scrubSecretMaterial(
    truncateForScrub(bodySample, BODY_SAMPLE_MAX_CHARS + BODY_SAMPLE_SCRUB_MARGIN),
  );
  const truncated =
    bodySample.length > BODY_SAMPLE_MAX_CHARS
      ? scrubbed.slice(0, BODY_SAMPLE_MAX_CHARS) + "…"
      : scrubbed;
  logger.warn("oauth llm: upstream response non-2xx", {
    credentialId,
    targetUrl,
    method,
    status: upstream.status,
    contentType: upstream.headers.get("content-type"),
    responseHeaders,
    bodySample: truncated,
  });
  return upstream;
}

function llmFetchErrorResponse(targetUrl: string, err: unknown): Response {
  const code = err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
  let domain: string | undefined;
  try {
    domain = new URL(targetUrl).hostname;
  } catch {
    // Not a parseable URL — omit the hostname hint rather than fail.
  }
  const suffix = code ? `: ${code}` : "";
  // The host dialed: the platform API (platform mode) or the subscription
  // provider (oauth) — never an aliased backing, which pi-ai dials itself.
  const domainHint = domain ? ` (${domain})` : "";
  return llmProxyError(502, "api_error", `LLM request failed${suffix}${domainHint}`);
}

/** A `/llm/*` refusal in the provider-shaped envelope, typed in Anthropic's error vocabulary. */
function llmProxyError(
  status: number,
  type: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return new Response(llmProxyErrorBody(type, message, extra), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The `/llm` 413, with the same `PAYLOAD_TOO_LARGE` `error.code` as the mcp.ts
 * envelope cap.
 */
function llmBodyOversizeError(actual: number | null): Response {
  return llmProxyError(
    413,
    "request_too_large",
    actual !== null
      ? `Request body exceeds ${MAX_REQUEST_BODY_SIZE} bytes (declared ${actual}).`
      : `Request body exceeds ${MAX_REQUEST_BODY_SIZE} bytes.`,
    {
      code: "PAYLOAD_TOO_LARGE",
      limit: MAX_REQUEST_BODY_SIZE,
      ...(actual !== null ? { actual } : {}),
      envVar: "SIDECAR_MAX_REQUEST_BODY_BYTES",
    },
  );
}

/**
 * Buffer an inbound `/llm` request body as bytes under a hard byte cap.
 * Enforces a `Content-Length` precheck when declared AND the actual
 * buffered byte length (a missing/spoofed Content-Length is still
 * bounded by the streaming read). Returns the original bytes, or a 413
 * `Response` the caller returns verbatim.
 *
 * Replaces a bare `await c.req.raw.text()` — that path was uncapped after
 * `oauth-identity.ts` (which carried the `MAX_REQUEST_BODY_SIZE` →
 * `TransformBodyTooLargeError` → 413 guard) was deleted.
 */
async function bufferLlmBodyBytesBounded(
  c: Context,
  maxBytes: number,
): Promise<Uint8Array | Response> {
  const declared = c.req.header("content-length");
  if (declared !== undefined) {
    const declaredLength = Number(declared);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return llmBodyOversizeError(declaredLength);
    }
  }
  const bytes = await readRequestBodyBounded(c.req.raw, maxBytes);
  if (bytes === "exceeded") {
    return llmBodyOversizeError(null);
  }
  return bytes;
}

/** Decode a bounded JSON body as text. */
async function bufferLlmBodyBounded(c: Context, maxBytes: number): Promise<string | Response> {
  const bytes = await bufferLlmBodyBytesBounded(c, maxBytes);
  if (bytes instanceof Response) return bytes;
  return new TextDecoder().decode(bytes);
}

/**
 * Derive the upstream `/llm/*` target from the inbound request: strip the
 * `/llm` mount prefix, re-append the query string onto the configured base URL,
 * and surface the method. Shared by both `/llm` branches (platform + oauth);
 * each keeps its own credential handling.
 *
 * The stripped `path` is returned alongside the composed URL because the alias
 * surface check needs exactly that suffix — the same one the in-container SDK
 * appended to `MODEL_BASE_URL` — and recomputing the slice at the call site
 * would be a second place for the two to disagree.
 */
function deriveLlmTarget(
  c: Context,
  baseUrl: string,
): { targetUrl: string; method: string; path: string } {
  const path = c.req.path.slice("/llm".length) || "/";
  const qs = new URL(c.req.url).search;
  return { targetUrl: `${baseUrl}${path}${qs}`, method: c.req.method, path };
}

/** Where a platform-mode `/llm/*` call goes, and how the sidecar authenticates there. */
interface PlatformLlmUpstream {
  baseUrl: string;
  /** The only reachable path: the proxy serves inference and nothing else. */
  inferencePath: string;
  /** Upstream headers for a forwarded request. */
  headers(incoming: Record<string, string>): Headers;
  /** Where and how pi-ai re-originates an aliased call. */
  pi: PiMessagesBackendDeps["upstream"];
}

/** Throws for a shape the proxy does not serve — `server.ts` refuses it at boot too. */
function platformLlmUpstream(
  config: SidecarConfig,
  llm: LlmProxyPlatformConfig,
): PlatformLlmUpstream {
  if (!isProxiedApiShape(llm.apiShape)) {
    throw new Error(`LLM api shape "${llm.apiShape}" is not served by the platform LLM proxy`);
  }
  const headers = { authorization: `Bearer ${config.runToken}` };
  const baseUrl = llmProxyBaseUrl(config.platformApiUrl, llm.apiShape, RUN_LLM_PROXY_MOUNT);
  return {
    baseUrl,
    inferencePath: LLM_PROXY_ROUTES[llm.apiShape].sdkPath,
    headers: (incoming) => {
      const forwarded = forwardedLlmRequestHeaders(incoming);
      forwarded.set("authorization", headers.authorization);
      return forwarded;
    },
    // The Model keeps the backing's endpoint (pi-ai reads its dialect off it).
    pi: { modelBaseUrl: llm.baseUrl, proxyBaseUrl: baseUrl, headers },
  };
}

/**
 * Build the sidecar's HTTP surface.
 *
 *   - `GET  /health`     — readiness probe.
 *   - `ALL  /llm/*`      — reverse proxy to the run's LLM upstream (the
 *                          platform's metered LLM proxy, or the OAuth
 *                          subscription provider). The Pi SDK (in-container)
 *                          calls `${MODEL_BASE_URL}/v1/chat/completions` (or
 *                          equivalent) over HTTP — MCP `tools/call` is
 *                          unsuitable for a streamed completion the SDK
 *                          consumes natively. The sidecar replaces the
 *                          placeholder in the SDK's auth header with its own
 *                          upstream auth, then streams the upstream response
 *                          back to the agent without buffering. The agent
 *                          never sees a credential.
 *   - `ALL  /mcp`        — JSON-RPC entrypoint mounted by `mountMcp`.
 *                          Exposes `{ns}__api_call`, `run_history`, and
 *                          `recall_memory` as MCP tools backed by the
 *                          credential-proxy core in `credential-proxy.ts`.
 */
/**
 * Run-scoped runtime singletons shared between the HTTP `/mcp` surface
 * (`createApp` → `mountMcp`) and the integration boot pipeline
 * (`bootIntegrations`). Building them once and threading the SAME
 * instances is what lets the in-process `api_call` MCP server and the
 * outer server agree on one blob store / token budget / concurrency cap.
 */
export interface SidecarRuntimeDeps {
  blobStore: BlobStore;
  tokenBudget: TokenBudget;
  apiCallLimit: LimitFunction;
  /**
   * Run-scoped credential-proxy deps WITHOUT the credential pair — each
   * integration's `fetchCredentials` / `refreshCredentials` are layered on
   * per tool by `mountMcp` / `createApiCallToolDefs` from the integration's
   * live credentials source.
   */
  proxyDeps: ApiCallBaseDeps;
}

/**
 * Build the run-scoped runtime deps from {@link AppDeps}. Pure
 * construction (no I/O beyond reading env vars + one info log). Called
 * once in `server.ts` (shared with boot) and as a fallback inside
 * `createApp` for tests that don't pre-build them.
 */
/**
 * Blob-store cap for production sidecars. MUST stay well below the
 * sidecar container's cgroup memory limit (SIDECAR_MEMORY_BYTES =
 * 256 MiB, `apps/api/src/services/orchestrator/constants.ts`): a cap at
 * or near the cgroup limit means the kernel OOM-killer fires before the
 * store's own guard, killing every integration mid-run. 128 MiB leaves
 * headroom for the Bun runtime, spawned-runner bookkeeping, and
 * in-flight request buffers. `BlobStore` takes no default for this
 * reason — the value is always a deliberate choice by the caller.
 */
const RUN_BLOB_STORE_MAX_BYTES = 128 * 1024 * 1024;

export function buildSidecarRuntimeDeps(deps: AppDeps): SidecarRuntimeDeps {
  const fetchFn = deps.fetchFn ?? fetch;
  const blobStore = new BlobStore(deps.runId ?? "unknown", {
    maxTotalBytes: RUN_BLOB_STORE_MAX_BYTES,
  });
  const inlineCapTokens = readPositiveTokenEnv(
    "SIDECAR_INLINE_TOOL_OUTPUT_TOKENS",
    DEFAULT_INLINE_OUTPUT_TOKENS,
  );
  const runBudgetTokens = readPositiveTokenEnv(
    "SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS",
    DEFAULT_RUN_OUTPUT_BUDGET_TOKENS,
  );
  const tokenBudget = new TokenBudget({
    inlineCapTokens,
    runBudgetTokens,
    ...(deps.config.modelContextWindow !== undefined
      ? { contextWindowTokens: deps.config.modelContextWindow }
      : {}),
    ...(deps.config.modelMaxTokens !== undefined && deps.config.modelContextWindow !== undefined
      ? { reserveTokens: deps.config.modelMaxTokens }
      : {}),
  });
  logger.info("token-budget configured", {
    inlineCapTokens: tokenBudget.inlineCapTokens,
    runBudgetTokens: tokenBudget.runBudgetTokens,
    contextWindowTokens: tokenBudget.contextWindowTokens,
    reserveTokens: tokenBudget.reserveTokens,
  });
  const apiCallLimit: LimitFunction = pLimit(
    readPositiveIntEnv("SIDECAR_API_CALL_CONCURRENCY", DEFAULT_API_CALL_CONCURRENCY),
  );
  const proxyDeps: ApiCallBaseDeps = {
    config: deps.config,
    cookieJar: deps.cookieJar,
    fetchFn,
    reportedAuthFailures: new Set<string>(),
  };
  return { blobStore, tokenBudget, apiCallLimit, proxyDeps };
}

export function createApp(deps: AppDeps): Hono {
  const { config } = deps;
  const platformUpstream =
    config.llm?.authMode === "platform" ? platformLlmUpstream(config, config.llm) : null;
  const fetchFn = deps.fetchFn ?? fetch;
  const isReady = deps.isReady ?? (() => true);

  const app = new Hono();

  // ─── Agent authentication for the whole control surface ───
  //
  // DENY BY DEFAULT, with `/health` as the single exemption: a route added to
  // this app later is protected without anyone remembering to say so, which is
  // the opposite of how `/llm/*`, `/mcp`, `/integrations/boot-report` and
  // `/runtime-events` each ended up open one at a time.
  //
  // `/health` is exempt because it is the container health gate — the
  // orchestrator probes it before the run exists and it discloses one bit
  // (ready / not ready) that reveals nothing about the run.
  //
  // Registered BEFORE every route below (Hono runs middleware in registration
  // order and only for routes registered after it) and before the `mountMcp`
  // call at the bottom of this function, which is why `/mcp` is covered too.
  //
  // Nothing runner-facing lives on this app: the per-integration egress / MITM
  // listeners and the DNS responder are their own `Bun.serve` listeners
  // (`integration-egress-listener.ts`, `integration-mitm-listener.ts`,
  // `integration-dns-responder.ts`), and the forward proxy is a separate one
  // bound on `PORT + 1` (`server.ts`). So there is no exemption to carve for
  // integration runners — they are not supposed to reach this app at all.
  app.use("*", async (c, next) => {
    if (c.req.path === HEALTH_PATH) return next();
    if (!isAuthorizedAgentRequest(c.req.header(SIDECAR_AUTH_HEADER), config.sidecarAuthToken)) {
      // No hint about which half failed, and no `WWW-Authenticate` challenge:
      // the only legitimate caller was handed the token at container start and
      // has nothing to negotiate.
      logger.warn("sidecar control surface: unauthenticated request refused", {
        path: c.req.path,
        method: c.req.method,
      });
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  // Health check for startup readiness (includes forward proxy readiness)
  app.get("/health", (c) => {
    if (!isReady()) {
      return c.json({ status: "degraded", proxy: "not ready" }, 503);
    }
    return c.json({ status: "ok" });
  });

  // Integration boot report. The agent's bootloader polls this after the MCP
  // handshake to relay the per-phase breadcrumbs into the run log and to abort
  // the run when any declared integration failed to boot (`ok: false`). We
  // await the boot promise so the report is final before answering.
  //
  // Authenticated like the rest of the control surface, by the
  // `SIDECAR_AUTH_HEADER` middleware above. The agent container still holds NO
  // run token — the zero-knowledge boundary is intact — but it does hold a
  // sidecar-only token, because the per-run Docker network is NOT a boundary:
  // integration runner containers sit on it too. The payload carries
  // integration ids + diagnostic errors but never credentials.
  app.get("/integrations/boot-report", async (c) => {
    if (!deps.integrationBootReportProvider) {
      // No integrations were wired into this sidecar — nothing to fail on.
      return c.json({
        ok: true,
        declared: 0,
        adapter: "none",
        spawned: [],
        failed: [],
        breadcrumbs: [],
      } satisfies IntegrationBootReport);
    }
    // Block until the initial boot pass settles so the report is authoritative.
    await deps.integrationBootPromise;
    return c.json(deps.integrationBootReportProvider());
  });

  // LLM reverse proxy. Two modes:
  //
  //   - oauth: the no-forge path for an OAuth subscription. The Pi SDK
  //     already signs the subscription request shape (Anthropic OAuth
  //     fingerprint or codex-responses headers); the sidecar resolves a fresh
  //     access token from the platform (`/internal/oauth-token/:id`) and swaps
  //     the placeholder request bearer for it — forging nothing. On 401 we
  //     refresh + retry once. There is no fingerprint-forging mode.
  //   - platform: forward to the platform's metered LLM proxy with the run
  //     token in place of the placeholder; inference endpoint only. Bodies
  //     stream through zero-copy; the Pi SDK retries 429/5xx natively.
  app.all("/llm/*", async (c) => {
    const llm = config.llm;
    if (!llm) {
      return llmProxyError(503, "api_error", "LLM proxy not configured");
    }

    if (llm.authMode === "oauth") {
      if (isBlockedEgressUrl(llm.baseUrl)) {
        return llmProxyError(
          403,
          "permission_error",
          "LLM base URL targets a blocked network range",
        );
      }
      return handleOauthLlmRequest(c, llm);
    }

    // Built by `createApp` for every platform config (it throws otherwise).
    const upstreamLlm = platformUpstream!;
    const { targetUrl, method, path } = deriveLlmTarget(c, upstreamLlm.baseUrl);

    // ALIASED runs get a narrowed `/llm/*` surface — the pi-messages inference
    // call only — refused HERE, before any upstream call.
    if (llm.modelSwap) {
      const swap = llm.modelSwap;
      if (!isAliasInferenceCall(method, path)) {
        logger.warn("llm alias: non-inference request refused", {
          method,
          path,
          // The CLIENT protocol only. `backingApiShape` narrows the candidate
          // vendor set and these logs are operator-visible on a surface whose
          // whole contract is that the backing stays private.
          clientApiShape: swap.clientApiShape,
        });
        // Same neutral envelope as every other alias refusal — a distinct
        // shape would itself be a signal to probe with. 404 reads as "no such
        // endpoint here", which is the truth of the narrowed surface.
        return new Response(syntheticAliasErrorBody(swap, 404), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      // An alias is TERMINATED here, never proxied: the container emits pi-ai's
      // vendor-neutral `pi-messages` so no vendor request shape or response
      // dialect ever reaches it, and the sidecar re-originates the call against
      // the real backing through pi-ai (`pi-messages-backend.ts`). Everything
      // below — the header swap, the body forward, the response passthrough —
      // serves non-aliased runs only.
      const buffered = await bufferLlmBodyBounded(c, MAX_REQUEST_BODY_SIZE);
      if (buffered instanceof Response) return buffered;
      return handlePiMessagesRequest(
        {
          upstream: upstreamLlm.pi,
          swap,
          // Token limits the backend needs to size the upstream call.
          limits: {
            ...(config.modelContextWindow !== undefined
              ? { modelContextWindow: config.modelContextWindow }
              : {}),
            ...(config.modelMaxTokens !== undefined
              ? { modelMaxTokens: config.modelMaxTokens }
              : {}),
          },
          ...(deps.llmStreamIdleTimeoutMs !== undefined
            ? { llmStreamIdleTimeoutMs: deps.llmStreamIdleTimeoutMs }
            : {}),
        },
        c.req.raw,
        buffered,
      );
    }

    if (method !== "POST" || path !== upstreamLlm.inferencePath) {
      logger.warn("llm: non-inference request refused", { method, path });
      return llmProxyError(404, "not_found_error", "Not an inference endpoint");
    }

    // Shared LLM header policy, plus this upstream's auth.
    const forwardedHeaders = upstreamLlm.headers(c.req.header());

    // Zero-copy body forward — nothing here rewrites the request.
    const body = c.req.raw.body ?? undefined;

    let upstream: Response;
    // THREE deadlines now bound an LLM stream, and the split matters:
    //   - `LLM_PROXY_TIMEOUT_MS` (30 min) — absolute cap on the whole
    //     exchange, the right ceiling for a long agentic completion.
    //   - `LLM_FIRST_RESPONSE_TIMEOUT_MS` (60 s) — TTFB. Disarmed the instant
    //     the headers land (`abort.firstResponse()` in the `finally`), because
    //     an abort signal handed to `fetch` tears down the BODY too.
    //   - `LLM_STREAM_IDLE_TIMEOUT_MS` (120 s) — inter-chunk silence, enforced
    //     in `passUpstream`, NOT here (a fetch-level signal cannot express
    //     "silent for 2 min" without also capping the total).
    // HISTORY, do not re-litigate: this block used to say there was
    // "deliberately no inter-chunk timeout", because undici's hardcoded 300 s
    // `bodyTimeout` once motivated a global `globalThis.fetch` → undici swap
    // that was reverted in #366 (see issue #369). That reasoning stands —
    // undici is still not the answer, the sidecar runs Bun's native `fetch`
    // and we are not swapping it back. What changed is that "no body timeout"
    // stopped being acceptable: pi-ai's per-adapter `timeoutMs` is not honoured
    // by every api shape we map (`pi-messages` ignores it), so a stalled stream had NO bound
    // below 30 min and runs died on their wall-clock watchdog with no error.
    // The idle bound lives in our own stream wrapper instead — provider
    // agnostic, and no transport swap.
    const abort = llmUpstreamAbort();
    try {
      upstream = await fetchFn(targetUrl, {
        method,
        headers: forwardedHeaders,
        body,
        signal: abort.signal,
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      });
    } catch (err) {
      return llmFetchErrorResponse(targetUrl, err);
    } finally {
      // Headers are in (or the call already failed) — the upstream has proven
      // it is alive, so the TTFB timer must stop before it can abort the body.
      abort.firstResponse();
    }

    return passUpstream(
      upstream,
      { targetUrl, authMode: llm.authMode },
      deps.llmStreamIdleTimeoutMs,
    );
  });

  // OAuth: resolve the real subscription bearer and swap it onto the request,
  // but DO NOT forge — no identity headers, no body transform. The Pi SDK
  // (in-container) already signed the subscription request shape (Anthropic
  // OAuth fingerprint or codex-responses headers); we forward its user-agent /
  // anthropic-beta / chatgpt-account-id untouched, forward the body verbatim
  // (no modelSwap in oauth mode — aliases are rejected platform-side), and only
  // replace the placeholder bearer with the real token.
  async function handleOauthLlmRequest(
    c: Context,
    llmConfig: LlmProxyOauthConfig,
  ): Promise<Response> {
    const tokenCache = deps.oauthTokenCache;
    if (!tokenCache) {
      return llmProxyError(503, "api_error", "OAuth token cache not configured");
    }

    let token: CachedToken;
    try {
      token = await tokenCache.getToken(llmConfig.credentialId);
    } catch (err) {
      if (err instanceof NeedsReconnectionError) {
        return llmProxyError(401, "authentication_error", "OAuth connection needs reconnection", {
          needsReconnection: true,
        });
      }
      // Log the detail server-side; return a generic message to the in-container
      // agent so platform-side error internals never cross the sidecar boundary.
      logger.warn("oauth llm: token resolution failed", {
        credentialId: llmConfig.credentialId,
        error: stringifyError(err),
      });
      return llmProxyError(502, "api_error", "OAuth token resolution failed");
    }

    const baseUrl = llmConfig.baseUrl;
    if (isBlockedEgressUrl(baseUrl)) {
      return llmProxyError(
        403,
        "permission_error",
        "Resolved OAuth base URL targets a blocked network range",
      );
    }

    const { targetUrl, method } = deriveLlmTarget(c, baseUrl);

    // The shared LLM header policy, then the real subscription bearer. The
    // SDK's own fingerprint (user-agent, anthropic-beta, chatgpt-account-id)
    // is preserved — the whole point of pass-through.
    const buildHeaders = (accessToken: string): Headers =>
      applyOauthBearerSwap(forwardedLlmRequestHeaders(c.req.header()), accessToken);

    // Buffer the request body (inference JSON, bounded by
    // SIDECAR_MAX_REQUEST_BODY_BYTES via the Content-Length precheck +
    // bounded streaming read → 413) so a 401 can be replayed after a token
    // refresh — a consumed stream can't be. The body is forwarded VERBATIM:
    // the oauth mode carries no modelSwap (aliases are rejected platform-side)
    // and never rewrites what Pi signed.
    let body: Uint8Array | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const buffered = await bufferLlmBodyBytesBounded(c, MAX_REQUEST_BODY_SIZE);
      if (buffered instanceof Response) return buffered;
      body = buffered.byteLength > 0 ? buffered : undefined;
    }

    // Same deadline split as the platform path above (absolute cap + TTFB
    // bound disarmed on headers; inter-chunk silence handled by
    // `passUpstream`). Armed PER ATTEMPT: the 401 replay below re-enters this
    // closure and must get its own fresh TTFB window rather than inherit an
    // already-half-spent one.
    const doFetch = async (headers: Headers): Promise<Response> => {
      const abort = llmUpstreamAbort();
      try {
        return await fetchFn(targetUrl, {
          method,
          headers,
          body,
          signal: abort.signal,
        } as RequestInit);
      } finally {
        abort.firstResponse();
      }
    };

    let upstream: Response;
    try {
      upstream = await doFetch(buildHeaders(token.accessToken));
    } catch (err) {
      logger.error("oauth llm: upstream fetch threw", {
        credentialId: llmConfig.credentialId,
        targetUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return llmFetchErrorResponse(targetUrl, err);
    }

    upstream = await logOauthLlmResponse(llmConfig.credentialId, targetUrl, method, upstream);

    // 401 retry: invalidate + force-refresh the token, replay once.
    if (upstream.status === 401) {
      tokenCache.invalidate(llmConfig.credentialId);
      try {
        const refreshed = await tokenCache.forceRefresh(llmConfig.credentialId);
        upstream = await doFetch(buildHeaders(refreshed.accessToken));
        upstream = await logOauthLlmResponse(llmConfig.credentialId, targetUrl, method, upstream);
      } catch (err) {
        if (err instanceof NeedsReconnectionError) {
          return llmProxyError(401, "authentication_error", "OAuth connection needs reconnection", {
            needsReconnection: true,
          });
        }
        // Refresh/replay failed for another reason (network, parse) — log it
        // so a recurring 401 isn't silently masked as a plain upstream 401,
        // then fall through and return the original response best-effort.
        logger.warn("oauth llm: token refresh/replay failed after 401", {
          credentialId: llmConfig.credentialId,
          targetUrl,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // No model-alias swap on the oauth path — the response streams back
    // verbatim (zero-copy telemetry passthrough only).
    return passUpstream(
      upstream,
      {
        targetUrl,
        credentialId: llmConfig.credentialId,
        authMode: "oauth",
      },
      deps.llmStreamIdleTimeoutMs,
    );
  }

  // MCP exposure — the agent-facing surface for the first-party tools
  // (`run_history`, `recall_memory`) plus every integration tool the
  // McpHost aggregates (spawned/remote MCP servers AND the in-process
  // `api_call` server). Run-scoped deps are built once and shared with
  // `bootIntegrations` (when `server.ts` pre-builds them) so the
  // in-process api_call server and the outer resource provider use the
  // same blob store.
  // Runtime-event drain surface — the Pi runner pulls the
  // canonical events the sidecar journaled while executing runtime tools, and
  // re-emits them on its single run-event sink. Same posture as `/mcp`: the
  // agent-auth middleware gates it, and the `Host` check on top is the
  // DNS-rebinding defence. An empty journal (no runtime tools selected)
  // answers an empty batch.
  app.get("/runtime-events", (c) => {
    const denied = validateMcpHostHeader(c.req.raw);
    if (denied) return denied;
    const journal = deps.runtimeEventJournal;
    if (!journal) return c.json({ events: [], cursor: 0, firstSeq: 1 });
    const after = Number.parseInt(c.req.query("after") ?? "0", 10);
    const cursor = Number.isFinite(after) && after >= 0 ? after : 0;
    return c.json(journal.after(cursor));
  });

  const { blobStore, tokenBudget, apiCallLimit, proxyDeps } =
    deps.runtimeDeps ?? buildSidecarRuntimeDeps(deps);
  mountMcp(app, {
    blobStore,
    tokenBudget,
    apiCallLimit,
    proxyDeps,
    ...(deps.additionalMcpToolsProvider
      ? { additionalToolsProvider: deps.additionalMcpToolsProvider }
      : {}),
    ...(deps.integrationBootPromise ? { integrationBootPromise: deps.integrationBootPromise } : {}),
  });

  return app;
}
