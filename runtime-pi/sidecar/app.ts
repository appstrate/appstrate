// SPDX-License-Identifier: Apache-2.0

import { Hono, type Context } from "hono";
import pLimit, { type LimitFunction } from "p-limit";
import { mountMcp, validateMcpHostHeader } from "./mcp.ts";
import { RuntimeEventJournal } from "./runtime-event-journal.ts";
import type { ApiCallDeps } from "./credential-proxy.ts";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { BlobStore } from "./blob-store.ts";
import type { IntegrationBootReport } from "@appstrate/core/sidecar-types";
import {
  DEFAULT_API_CALL_CONCURRENCY,
  LLM_PROXY_TIMEOUT_MS,
  MAX_REQUEST_BODY_SIZE,
  filterHeaders,
  readPositiveIntEnv,
  readRequestBodyBounded,
  type SidecarConfig,
  type CredentialsResponse,
  type LlmProxyOauthConfig,
  type ModelSwap,
} from "./helpers.ts";
import { isBlockedEgressUrl } from "./ssrf.ts";
import {
  swapRequestModel,
  swapResponseModelJson,
  createSseModelSwapStream,
  syntheticAliasErrorBody,
  LLM_PASSTHROUGH_RESPONSE_HEADERS,
} from "./model-swap.ts";
import { applyOauthBearerSwap } from "@appstrate/core/oauth-bearer-swap";
import {
  DEFAULT_INLINE_OUTPUT_TOKENS,
  DEFAULT_RUN_OUTPUT_BUDGET_TOKENS,
  TokenBudget,
  readPositiveTokenEnv,
} from "./token-budget.ts";
import { OAuthTokenCache, NeedsReconnectionError, type CachedToken } from "./oauth-token-cache.ts";
import { logger } from "./logger.ts";
import { filterSensitiveHeaders } from "./redact.ts";

export type { SidecarConfig } from "./helpers.ts";

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
  fetchCredentials: (integrationId: string) => Promise<CredentialsResponse>;
  refreshCredentials?: NonNullable<ApiCallDeps["refreshCredentials"]>;
  cookieJar: Map<string, string[]>;
  fetchFn?: typeof fetch; // default: global fetch — injectable for tests
  isReady?: () => boolean; // default: () => true — controls /health
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
  authMode?: "oauth" | "api_key";
}

async function passUpstream(
  upstream: Response,
  observe?: LlmStreamObservation,
  swap?: ModelSwap,
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

  const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();

  // Model-alias ERROR bodies are SYNTHESIZED, never forwarded. Provider error
  // payloads are free-form prose that can name the backing anywhere (model id,
  // hostname, provider vocabulary) — and an alias's whole point is the agent
  // never learns the backing. So the upstream body stays server-side (logged
  // for the operator, truncated) and the agent gets a neutral JSON envelope;
  // status + allowlisted headers still flow for retry/backoff. Applies to ANY
  // content type on a non-2xx, mirroring the platform gateway (`llm-proxy/
  // core.ts`); errors are tiny, so buffering them costs nothing.
  if (swap && !upstream.ok) {
    let bodySample = "";
    try {
      bodySample = await upstream.text();
    } catch {
      // body unreadable — log what we have
    }
    logger.warn("llm alias: upstream error body replaced by synthetic envelope", {
      targetUrl: observe?.targetUrl,
      status: upstream.status,
      contentType: upstream.headers.get("content-type"),
      bodySample: bodySample.length > 200 ? bodySample.slice(0, 200) + "…" : bodySample,
    });
    // The synthesized body is JSON even when the upstream error was text/html —
    // the allowlist copied the upstream's content-type, so override it.
    responseHeaders["Content-Type"] = "application/json";
    return new Response(syntheticAliasErrorBody(swap, upstream.status), {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  // Model-alias swap (response real→alias). A non-stream JSON body can't be
  // rewritten chunk-by-chunk — buffer the whole thing, swap, re-serialize. SSE
  // is rewritten in-stream below (frame-buffered). Other content types and the
  // no-swap path keep the zero-copy telemetry passthrough.
  if (swap && contentType.includes("application/json") && !contentType.includes("event-stream")) {
    const text = await upstream.text();
    const rewritten = swapResponseModelJson(text, swap);
    // Length changed by the rewrite — let Response recompute Content-Length
    // rather than forward a now-wrong upstream value.
    return new Response(rewritten, { status: upstream.status, headers: responseHeaders });
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
  const observed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
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

  // Model-alias swap on a streaming (SSE) body: rewrite `model` real→alias in
  // each frame as it flows. Frame-buffered, so a chunk boundary mid-frame is
  // handled. The telemetry passthrough (`observed`) stays in front so stream
  // metrics still reflect the upstream timing.
  const body =
    swap && contentType.includes("event-stream")
      ? observed.pipeThrough(createSseModelSwapStream(swap))
      : observed;

  return new Response(body, { status: upstream.status, headers: responseHeaders });
}

/**
 * On non-2xx upstream responses, clone the body for the operator-facing
 * warn log (the agent still consumes the original stream). 2xx is silent —
 * normal traffic shouldn't pollute the log. Returns the original response.
 */
async function logOauthLlmResponse(
  credentialId: string,
  targetUrl: string,
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
  const scrubbed = bodySample.replace(/(sk-ant-[a-z0-9-]+|Bearer\s+[\w.~+/=-]+)/gi, "[redacted]");
  const truncated = scrubbed.length > 200 ? scrubbed.slice(0, 200) + "…" : scrubbed;
  logger.warn("oauth llm: upstream response non-2xx", {
    credentialId,
    targetUrl,
    status: upstream.status,
    contentType: upstream.headers.get("content-type"),
    responseHeaders,
    bodySample: truncated,
  });
  return upstream;
}

function llmFetchErrorResponse(
  c: Context,
  targetUrl: string,
  err: unknown,
  swap?: ModelSwap,
): Response {
  const code = err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
  let domain: string | undefined;
  try {
    domain = new URL(targetUrl).hostname;
  } catch {}
  const suffix = code ? `: ${code}` : "";
  // The hostname identifies the backing provider; with an alias it must never
  // reach the agent. The error `code` (e.g. ConnectionRefused) is generic and
  // stays — it's useful and names nothing.
  const domainHint = domain && !swap ? ` (${domain})` : "";
  return c.json({ error: `LLM request failed${suffix}${domainHint}` }, 502);
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The `/llm` 413 envelope. Mirrors the mcp.ts oversize-error shape so a
 * caller sees a consistent `PAYLOAD_TOO_LARGE` discriminator on both the
 * MCP envelope cap and this request-body cap.
 */
function llmBodyOversizeError(actual: number | null) {
  return {
    error:
      actual !== null
        ? `Request body exceeds ${MAX_REQUEST_BODY_SIZE} bytes (declared ${actual}).`
        : `Request body exceeds ${MAX_REQUEST_BODY_SIZE} bytes.`,
    reason: "PAYLOAD_TOO_LARGE" as const,
    limit: MAX_REQUEST_BODY_SIZE,
    ...(actual !== null ? { actual } : {}),
    envVar: "SIDECAR_MAX_REQUEST_BODY_BYTES",
  };
}

/**
 * Buffer an inbound `/llm` request body as text under a hard byte cap.
 * Enforces a `Content-Length` precheck when declared AND the actual
 * buffered byte length (a missing/spoofed Content-Length is still
 * bounded by the streaming read). Returns the decoded text, or a 413
 * `Response` the caller returns verbatim.
 *
 * Replaces a bare `await c.req.raw.text()` — that path was uncapped after
 * `oauth-identity.ts` (which carried the `MAX_REQUEST_BODY_SIZE` →
 * `TransformBodyTooLargeError` → 413 guard) was deleted.
 */
async function bufferLlmBodyBounded(c: Context, maxBytes: number): Promise<string | Response> {
  const declared = c.req.header("content-length");
  if (declared !== undefined) {
    const declaredLength = Number(declared);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return c.json(llmBodyOversizeError(declaredLength), 413);
    }
  }
  const bytes = await readRequestBodyBounded(c.req.raw, maxBytes);
  if (bytes === "exceeded") {
    return c.json(llmBodyOversizeError(null), 413);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Derive the upstream `/llm/*` target from the inbound request: strip the
 * `/llm` mount prefix, re-append the query string onto the configured base URL,
 * and surface the method. Shared by both `/llm` branches (api_key + oauth);
 * each keeps its own SSRF check (`isBlockedEgressUrl`) and credential handling.
 */
function deriveLlmTarget(c: Context, baseUrl: string): { targetUrl: string; method: string } {
  const path = c.req.path.slice("/llm".length) || "/";
  const qs = new URL(c.req.url).search;
  return { targetUrl: `${baseUrl}${path}${qs}`, method: c.req.method };
}

/**
 * Buffer an inbound `/llm` request body under the hard byte cap and apply the
 * model-alias swap when one is configured; otherwise return the buffered text
 * verbatim. Returns a 413 `Response` (the caller returns it verbatim) when the
 * body exceeds the cap, or `undefined` for an empty body. Used by both branches
 * that must materialise the body: oauth always (so a 401 can be replayed),
 * api_key only when an alias requires the rewrite (the no-swap api_key path
 * keeps its zero-copy stream).
 */
async function bufferAndSwapRequestBody(
  c: Context,
  modelSwap: ModelSwap | undefined,
): Promise<string | undefined | Response> {
  const buffered = await bufferLlmBodyBounded(c, MAX_REQUEST_BODY_SIZE);
  if (buffered instanceof Response) return buffered;
  const text = buffered;
  return text && modelSwap ? swapRequestModel(text, modelSwap) : text || undefined;
}

/**
 * Build the sidecar's HTTP surface.
 *
 *   - `GET  /health`     — readiness probe.
 *   - `ALL  /llm/*`      — reverse proxy to the platform-configured LLM
 *                          provider. The Pi SDK (in-container) calls
 *                          `${MODEL_BASE_URL}/v1/chat/completions` (or
 *                          equivalent) over HTTP — MCP `tools/call` is
 *                          unsuitable for a streamed completion the SDK
 *                          consumes natively. The sidecar swaps the
 *                          placeholder embedded in the SDK's auth header
 *                          for the real API key, then streams the
 *                          upstream response back to the agent without
 *                          buffering. The agent never sees the key.
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
  proxyDeps: ApiCallDeps;
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
 * 256 MiB, `apps/api/src/services/orchestrator/constants.ts`): at the
 * store's 256 MiB class default the kernel OOM-killer fires before the
 * store's own guard, killing every integration mid-run. 128 MiB leaves
 * headroom for the Bun runtime, spawned-runner bookkeeping, and
 * in-flight request buffers.
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
  const proxyDeps: ApiCallDeps = {
    config: deps.config,
    cookieJar: deps.cookieJar,
    fetchFn,
    fetchCredentials: deps.fetchCredentials,
    ...(deps.refreshCredentials ? { refreshCredentials: deps.refreshCredentials } : {}),
    reportedAuthFailures: new Set<string>(),
  };
  return { blobStore, tokenBudget, apiCallLimit, proxyDeps };
}

export function createApp(deps: AppDeps): Hono {
  const { config } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const isReady = deps.isReady ?? (() => true);

  const app = new Hono();

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
  // No inbound auth — same posture as `/mcp`. The agent container holds NO
  // run token (zero-knowledge boundary: only the sidecar can call back to the
  // platform), so a bearer check would lock the agent out. The security
  // boundary is the per-run Docker network; the payload carries integration
  // ids + diagnostic errors but never credentials.
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
  //   - api_key: the Pi SDK formats every header (auth, beta, identity)
  //     using the platform-supplied placeholder; we swap the placeholder
  //     for the real key and forward directly to the upstream provider.
  //     Request/response bodies stream through zero-copy. The Pi SDK
  //     handles retry on 429/5xx natively (Retry-After honoring + jitter).
  //   - oauth: the no-forge path for an OAuth subscription. The Pi SDK
  //     already signs the subscription request shape (Anthropic OAuth
  //     fingerprint or codex-responses headers); the sidecar resolves a fresh
  //     access token from the platform (`/internal/oauth-token/:id`) and swaps
  //     the placeholder request bearer for it — forging nothing. On 401 we
  //     refresh + retry once. There is no fingerprint-forging mode.
  app.all("/llm/*", async (c) => {
    if (!config.llm) {
      return c.json({ error: "LLM proxy not configured" }, 503);
    }

    if (isBlockedEgressUrl(config.llm.baseUrl)) {
      return c.json({ error: "LLM base URL targets a blocked network range" }, 403);
    }

    if (config.llm.authMode === "oauth") {
      return handleOauthLlmRequest(c, config.llm);
    }

    const apiKeyConfig = config.llm; // discriminated narrowing
    const { targetUrl, method } = deriveLlmTarget(c, apiKeyConfig.baseUrl);

    const filtered = filterHeaders(c.req.header());
    const forwardedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(filtered)) {
      forwardedHeaders[key] = value.includes(apiKeyConfig.placeholder)
        ? value.replace(apiKeyConfig.placeholder, apiKeyConfig.apiKey)
        : value;
    }

    // Model-alias swap (request alias→real). The body is normally forwarded as
    // a zero-copy ReadableStream; for an alias we must buffer it to rewrite the
    // `model` field. Only aliases pay that cost — every other model stays
    // zero-copy.
    let body: string | ReadableStream<Uint8Array> | undefined;
    if (method !== "GET" && method !== "HEAD") {
      if (apiKeyConfig.modelSwap) {
        // Buffer under a hard byte cap (Content-Length precheck + bounded
        // streaming read → 413) before the model-alias rewrite. A bare
        // `.text()` here would buffer an unbounded body into memory.
        const swapped = await bufferAndSwapRequestBody(c, apiKeyConfig.modelSwap);
        if (swapped instanceof Response) return swapped;
        body = swapped;
      } else {
        body = c.req.raw.body ?? undefined;
      }
    }

    let upstream: Response;
    try {
      // `AbortSignal.timeout(LLM_PROXY_TIMEOUT_MS)` is the ONLY deadline on
      // an LLM stream — an absolute 30 min cap, not an inactivity timer.
      // There is deliberately no inter-chunk (body) timeout: undici's
      // hardcoded 300 s `bodyTimeout` (which once motivated a global
      // `globalThis.fetch` → undici swap, reverted in #366, see issue #369)
      // does not exist here — the sidecar runs under Bun and `fetch` is
      // Bun's native implementation, not undici. A long inter-chunk gap on a
      // streamed completion therefore cannot trip a body timeout; it is only
      // bounded by the 30 min absolute deadline. Inter-chunk silence is still
      // observed (`maxIdleMs` in `llm.stream.observed`, #426) so any real
      // stall surfaces in logs without re-introducing undici.
      upstream = await fetchFn(targetUrl, {
        method,
        headers: forwardedHeaders,
        body,
        signal: AbortSignal.timeout(LLM_PROXY_TIMEOUT_MS),
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      });
    } catch (err) {
      return llmFetchErrorResponse(c, targetUrl, err, apiKeyConfig.modelSwap);
    }

    return passUpstream(upstream, { targetUrl, authMode: "api_key" }, apiKeyConfig.modelSwap);
  });

  // OAuth: resolve the real subscription bearer and swap it onto the request,
  // but DO NOT forge — no identity headers, no body transform. The Pi SDK
  // (in-container) already signed the subscription request shape (Anthropic
  // OAuth fingerprint or codex-responses headers); we forward its user-agent /
  // anthropic-beta / chatgpt-account-id untouched and only replace the
  // placeholder bearer with the real token.
  async function handleOauthLlmRequest(
    c: Context,
    llmConfig: LlmProxyOauthConfig,
  ): Promise<Response> {
    const tokenCache = deps.oauthTokenCache;
    if (!tokenCache) {
      return c.json({ error: "OAuth token cache not configured" }, 503);
    }

    let token: CachedToken;
    try {
      token = await tokenCache.getToken(llmConfig.credentialId);
    } catch (err) {
      if (err instanceof NeedsReconnectionError) {
        return c.json(
          { error: "OAuth connection needs reconnection", needsReconnection: true },
          401,
        );
      }
      // Log the detail server-side; return a generic message to the in-container
      // agent so platform-side error internals never cross the sidecar boundary.
      logger.warn("oauth llm: token resolution failed", {
        credentialId: llmConfig.credentialId,
        error: stringifyError(err),
      });
      return c.json({ error: "OAuth token resolution failed" }, 502);
    }

    const baseUrl = llmConfig.baseUrl;
    if (isBlockedEgressUrl(baseUrl)) {
      return c.json({ error: "Resolved OAuth base URL targets a blocked network range" }, 403);
    }

    const { targetUrl, method } = deriveLlmTarget(c, baseUrl);

    // Forward the SDK's headers verbatim except for the bearer-swap policy:
    // drop any x-api-key (bearer-only) and force the real subscription bearer.
    // The SDK's own fingerprint (user-agent, anthropic-beta, chatgpt-account-id)
    // is preserved — the whole point of pass-through. `filterHeaders` first
    // drops host/content-length/hop-by-hop; wrapping the result in a Headers
    // normalises casing so the swap needs no manual authorization variant hunt.
    const buildHeaders = (accessToken: string): Headers =>
      applyOauthBearerSwap(new Headers(filterHeaders(c.req.header())), accessToken);

    // Buffer the request body (inference JSON, bounded by
    // SIDECAR_MAX_REQUEST_BODY_BYTES via the Content-Length precheck +
    // bounded streaming read → 413) so a 401 can be replayed after a token
    // refresh — a consumed stream can't be. Apply the model-alias swap here
    // when configured; otherwise forward the body verbatim.
    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const swapped = await bufferAndSwapRequestBody(c, llmConfig.modelSwap);
      if (swapped instanceof Response) return swapped;
      body = swapped;
    }

    const doFetch = (headers: Headers): Promise<Response> =>
      fetchFn(targetUrl, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(LLM_PROXY_TIMEOUT_MS),
      } as RequestInit);

    let upstream: Response;
    try {
      upstream = await doFetch(buildHeaders(token.accessToken));
    } catch (err) {
      logger.error("oauth llm: upstream fetch threw", {
        credentialId: llmConfig.credentialId,
        targetUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return llmFetchErrorResponse(c, targetUrl, err, llmConfig.modelSwap);
    }

    upstream = await logOauthLlmResponse(llmConfig.credentialId, targetUrl, upstream);

    // 401 retry: invalidate + force-refresh the token, replay once.
    if (upstream.status === 401) {
      tokenCache.invalidate(llmConfig.credentialId);
      try {
        const refreshed = await tokenCache.forceRefresh(llmConfig.credentialId);
        upstream = await doFetch(buildHeaders(refreshed.accessToken));
        upstream = await logOauthLlmResponse(llmConfig.credentialId, targetUrl, upstream);
      } catch (err) {
        if (err instanceof NeedsReconnectionError) {
          return c.json(
            { error: "OAuth connection needs reconnection", needsReconnection: true },
            401,
          );
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

    return passUpstream(
      upstream,
      {
        targetUrl,
        credentialId: llmConfig.credentialId,
        authMode: "oauth",
      },
      llmConfig.modelSwap,
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
  // re-emits them on its single run-event sink. Same `Host: sidecar` posture as
  // `/mcp` (the per-run Docker network is the boundary; no token). An empty
  // journal (no runtime tools selected) answers an empty batch.
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
