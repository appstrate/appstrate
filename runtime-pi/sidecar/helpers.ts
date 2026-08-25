// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar-local constants + thin re-exports over `@appstrate/connect`
 * shared credential-proxy primitives. The shared module is the single
 * source of truth so any improvement (placeholder semantics, URL
 * allowlist matching, hop-by-hop header list) propagates to both the
 * public `/api/credential-proxy/proxy` route and this in-container
 * sidecar automatically.
 */

// Straight from core. `./ssrf.ts` used to sit in the middle, re-exporting
// these so this module could re-export them again; it added no behaviour and
// no consumer imported them from there. `./ssrf.ts` keeps only the sidecar's
// own egress-allowlist logic.
export { isBlockedHost, isBlockedUrl, resolveAndCheckHost } from "@appstrate/core/ssrf";
export type { HostResolver } from "@appstrate/core/ssrf";

// Imported (not just re-exported) because `readPositiveByteEnv` below defaults
// its `ceiling` parameter to it. See the re-export note further down.
import { ABSOLUTE_BODY_CEILING } from "@appstrate/afps-runtime/resolvers";
// Compiled default for the inter-chunk idle bound, shared with the platform LLM
// gateway. Imported (not just re-exported) because the env override below falls
// back to it.
import { DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS } from "@appstrate/connect/proxy-primitives";

// Accepts both simple IDs (gmail) and scoped IDs (@appstrate/gmail)
export const INTEGRATION_ID_RE = /^(@[a-z0-9][a-z0-9-]*\/)?[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Default cap on upstream response bytes the sidecar buffers before
// returning them inline. Set generously enough that typical provider
// responses (Drive metadata listings, Gmail thread snippets, paginated
// payloads) round-trip untruncated. Larger or binary responses spill
// to the run-scoped BlobStore and surface as MCP `resource_link`
// blocks; the absolute ceiling is `ABSOLUTE_MAX_RESPONSE_SIZE`.
export const MAX_RESPONSE_SIZE = 256 * 1024; // 256 KB
// NAME COLLISION, read before touching: `@appstrate/afps-runtime/resolvers`
// also exports an `ABSOLUTE_MAX_RESPONSE_SIZE`, it is 1 MB, and it means
// something else — the schema cap on the agent-supplied
// `responseMode.maxInlineBytes`. Both are loaded into THIS process (the sidecar
// imports the resolvers for `executeApiCall`), so an import written from memory
// silently picks the wrong ceiling by a factor of 32. This one is the
// transport-buffer ceiling: how many upstream bytes the sidecar will hold
// before refusing, applied only when a BlobStore is configured to spill them
// into (otherwise MAX_RESPONSE_SIZE is the cap). Renaming the 1 MB one to
// something like MAX_INLINE_RESPONSE_BYTES would end the ambiguity, but it
// lives in packages/afps-runtime.
export const ABSOLUTE_MAX_RESPONSE_SIZE = 32 * 1024 * 1024; // 32 MB — covers PDFs/images/archives, aligned with MAX_MCP_ENVELOPE_SIZE × 2
export const OUTBOUND_TIMEOUT_MS = 30_000;
const LLM_PROXY_TIMEOUT_MS = 1_800_000; // 30 minutes (patched from 300_000 — was killing legitimate long-running agentic runs at exactly 5 min)

/**
 * Bound on how long an LLM upstream may take to produce its RESPONSE HEADERS
 * (TTFB). Distinct from {@link LLM_PROXY_TIMEOUT_MS}, which is the ABSOLUTE
 * cap on the whole exchange: 30 min is the right ceiling for a legitimately
 * long agentic completion, and exactly the wrong instrument for "the upstream
 * never answered at all".
 *
 * Why this bound is safe at 60 s here even though a non-streaming completion
 * can legitimately hold its headers for minutes: the ONLY clients of the
 * sidecar's `/llm/*` surface are pi-ai's provider adapters running inside the
 * container, and every one of them issues `stream: true` (grep `stream: true`
 * in `@earendil-works/pi-ai/dist/api/*.js`). A streaming provider emits its
 * first SSE frame within seconds; 60 s is roughly 10× the worst honest TTFB
 * we have observed and still an order of magnitude under the shortest run
 * budget (300 s), so a dead upstream surfaces as an ERROR the agent can retry
 * instead of a silent wall-clock kill. The platform-side gateway
 * (`apps/api/src/services/llm-proxy`) serves non-streaming callers too and
 * therefore keeps a separate, far more generous bound for those — see
 * `LLM_NON_STREAMING_TIMEOUT_MS` there.
 *
 * MUST be disarmed once the headers land: an `AbortSignal` handed to `fetch`
 * aborts the BODY too, so leaving this armed would kill every stream at 60 s.
 * {@link llmUpstreamAbort} owns that lifecycle — do not inline
 * `AbortSignal.timeout(LLM_FIRST_RESPONSE_TIMEOUT_MS)` at a call site.
 *
 * Operator-overridable via `SIDECAR_LLM_FIRST_RESPONSE_TIMEOUT_MS`. The 60 s
 * reasoning above holds for hosted vendors; it does not hold for a self-hosted
 * `baseUrl` provider (Ollama / llama.cpp / vLLM), where a cold model load
 * routinely blocks the response HEADERS for minutes. Self-hosting is a
 * first-class deployment of this platform, so the bound is a default and not a
 * law.
 */
const LLM_FIRST_RESPONSE_TIMEOUT_MS = readPositiveIntEnv(
  "SIDECAR_LLM_FIRST_RESPONSE_TIMEOUT_MS",
  60_000,
  { unit: "ms" },
);

/**
 * Bound on INTER-CHUNK silence once an LLM stream is flowing: how long the
 * upstream may say nothing between two body chunks before the sidecar declares
 * the stream dead. Enforced in `passUpstream` (`./app.ts`) and, on the aliased
 * `pi-messages` path, in `handlePiMessagesRequest` — never as a fetch-level
 * signal, which cannot express "silent for 2 min" without also capping the
 * total.
 *
 * The value and the reasoning behind it live with the shared default
 * ({@link DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS} in
 * `@appstrate/connect/proxy-primitives`), which the platform LLM gateway reads
 * too. What is local here is the operator override:
 * `SIDECAR_LLM_STREAM_IDLE_TIMEOUT_MS`, for the self-hosted `baseUrl` providers
 * whose inter-chunk gaps a hosted-vendor default does not describe.
 */
export const LLM_STREAM_IDLE_TIMEOUT_MS = readPositiveIntEnv(
  "SIDECAR_LLM_STREAM_IDLE_TIMEOUT_MS",
  DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS,
  { unit: "ms" },
);

/**
 * Abort plumbing for one LLM upstream call: the absolute
 * {@link LLM_PROXY_TIMEOUT_MS} cap, the {@link LLM_FIRST_RESPONSE_TIMEOUT_MS}
 * TTFB bound, and optionally the caller's own signal, combined with
 * `AbortSignal.any` (the idiom already used in `pi-messages-backend.ts`).
 *
 * The returned `firstResponse()` MUST be called — from a `finally` — as soon
 * as the upstream has proven it is alive (headers received, or the first
 * stream event on the pi-messages path). An abort signal handed to `fetch`
 * tears down the response BODY as well, so a TTFB timer left armed would kill
 * every healthy stream at the 60 s mark. `@appstrate/afps-shared`'s
 * `guardedFetch` solves the same problem the same way (its `timeoutMs`
 * "covers the redirect chain up to the final response's HEADERS … the timer is
 * detached once the response is returned"); this is the hand-rolled twin for
 * the sidecar's raw `fetch` call sites.
 *
 * The abort reason NEVER reaches the agent: `fetch` rejects with this
 * DOMException, the `app.all("/llm/*")` handler's `catch` hands it to
 * `llmFetchErrorResponse` (`./app.ts`), which reads only `err.code` and answers
 * a generic `502 {"error":"LLM request failed…"}` — the message is dropped. On
 * the aliased `pi-messages` path it is replaced by `syntheticAliasErrorMessage`
 * for the same reason. It is worded for OUR logs.
 *
 * The retry still happens, by the status code: `502` is itself one of
 * `RETRYABLE_PROVIDER_ERROR_PATTERN`'s literals
 * (`@earendil-works/pi-ai/dist/utils/retry.js`), so pi-ai classifies the
 * refusal as transient and the agent retries the turn.
 */
export function llmUpstreamAbort(extra?: AbortSignal): {
  signal: AbortSignal;
  firstResponse: () => void;
} {
  const firstResponse = new AbortController();
  const timer = setTimeout(
    () =>
      firstResponse.abort(
        new DOMException(
          `LLM upstream timed out after ${LLM_FIRST_RESPONSE_TIMEOUT_MS}ms waiting for a response`,
          "TimeoutError",
        ),
      ),
    LLM_FIRST_RESPONSE_TIMEOUT_MS,
  );
  const signals: AbortSignal[] = [AbortSignal.timeout(LLM_PROXY_TIMEOUT_MS), firstResponse.signal];
  if (extra) signals.push(extra);
  return { signal: AbortSignal.any(signals), firstResponse: () => clearTimeout(timer) };
}

/**
 * Default cap on simultaneous `api_call` MCP invocations per run.
 * Three matches the typical browsing concurrency a single LLM turn can
 * usefully exploit while leaving headroom under most providers' per-IP
 * rate limits. Operators can override via
 * `SIDECAR_API_CALL_CONCURRENCY`.
 */
export const DEFAULT_API_CALL_CONCURRENCY = 3;

// Absolute hard-cap for any body-size env override, single-sourced from
// `@appstrate/afps-runtime/resolvers` — it applies the same ceiling to the
// request-body cap below, and two copies of `100 * 1024 * 1024` that agree
// only by coincidence are a coin-flip waiting to diverge.
export { ABSOLUTE_BODY_CEILING };

/**
 * Resolve a positive integer from an env var, falling back to
 * `defaultValue` when unset/empty. Throws on malformed values so
 * misconfiguration fails loud at sidecar boot rather than silently
 * masking the problem at runtime.
 *
 * Options:
 *   - `unit`    — label used in the error message (e.g. `"bytes"`, `"tokens"`).
 *                 Omit for a unit-agnostic message.
 *   - `ceiling` — hard upper bound; exceeding it throws with a message
 *                 that references the ceiling value and notes that
 *                 raising it requires code changes.
 */
export function readPositiveIntEnv(
  name: string,
  defaultValue: number,
  opts: { unit?: string; ceiling?: number } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  const unitSuffix = opts.unit ? ` (${opts.unit})` : "";
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer${unitSuffix}, got ${JSON.stringify(raw)}.`);
  }
  if (opts.ceiling !== undefined && parsed > opts.ceiling) {
    throw new Error(
      `${name}=${parsed} exceeds the absolute ceiling of ${opts.ceiling}${unitSuffix}. ` +
        `Caps above this require code changes (memory pressure on the sidecar).`,
    );
  }
  return parsed;
}

/**
 * Resolve a positive-integer byte cap from an env var, falling back to
 * `defaultValue` when unset/empty. Throws on malformed values or values
 * above {@link ABSOLUTE_BODY_CEILING} so misconfiguration fails loud at
 * sidecar boot rather than silently masking the problem at runtime.
 *
 * Thin wrapper over {@link readPositiveIntEnv} that pins
 * `unit: "bytes"` and a default ceiling of
 * {@link ABSOLUTE_BODY_CEILING} so call sites in this module don't
 * repeat the contract.
 */
export function readPositiveByteEnv(
  name: string,
  defaultValue: number,
  ceiling = ABSOLUTE_BODY_CEILING,
): number {
  return readPositiveIntEnv(name, defaultValue, { unit: "bytes", ceiling });
}

/**
 * Hard upper bound on `api_call` request bodies after base64 decode
 * (binary path) or string materialization (text path). Configurable via
 * `SIDECAR_MAX_REQUEST_BODY_BYTES`. Default 10 MB.
 *
 * Note: the effective user-facing limit is also bounded by
 * {@link MAX_MCP_ENVELOPE_SIZE} since base64 inflation (~1.37×) plus
 * JSON-RPC overhead must fit in the MCP envelope.
 *
 * NOT parsed here, read before touching: this used to be its own
 * `readPositiveByteEnv("SIDECAR_MAX_REQUEST_BODY_BYTES", …)` call, and
 * `@appstrate/afps-runtime/resolvers` parsed the SAME variable for its own
 * `MAX_REQUEST_BODY_SIZE` with the opposite failure policy — this one threw
 * at boot on a malformed or over-ceiling override, that one silently fell
 * back to 10 MB. Both module graphs load in THIS process (the sidecar imports
 * the resolvers for `executeApiCall`), so which policy an operator observed
 * was decided by import order: a typo'd override either wedged the sidecar or
 * quietly ran at the default. The resolvers now own the sole parse, and they
 * kept the strict policy — a cap the operator thinks they raised and did not
 * is a production incident waiting to happen — so the sidecar consumes their
 * value instead of re-deriving it.
 */
export { MAX_REQUEST_BODY_SIZE } from "@appstrate/afps-runtime/resolvers";

/**
 * Hard cap on the JSON-RPC envelope a single `/mcp` request may carry.
 * The SDK's `WebStandardStreamableHTTPServerTransport.handlePostRequest`
 * calls `await req.json()` unconditionally, so without this guard a
 * misbehaving caller from inside the run network could OOM the sidecar
 * with a multi-GB envelope. Configurable via
 * `SIDECAR_MAX_MCP_ENVELOPE_BYTES`. Default 16 MB — sized to fit a
 * base64-encoded {@link MAX_REQUEST_BODY_SIZE} (10 MB × ~1.37) plus
 * JSON-RPC overhead.
 */
export const MAX_MCP_ENVELOPE_SIZE = readPositiveByteEnv(
  "SIDECAR_MAX_MCP_ENVELOPE_BYTES",
  16 * 1024 * 1024,
);

// `STREAMING_THRESHOLD` and `MAX_STREAMED_BODY_SIZE` used to be declared here
// too, and had zero importers. The values that actually gate a request are the
// same-named ones in `@appstrate/afps-runtime/resolvers`: `STREAMING_THRESHOLD`
// is applied inside the shared outbound-HTTP engine, and `MAX_STREAMED_BODY_SIZE`
// is imported from there by `mcp/api-upload-resolver.ts`. Two same-named
// constants that agree only by coincidence are a coin-flip waiting to diverge,
// so the unused pair is gone rather than kept "for symmetry".

/**
 * Concatenate read chunks into one buffer, dropping each source
 * reference as it is copied.
 *
 * The naive `for (const c of chunks) merged.set(c, …)` keeps the whole
 * `chunks` array reachable for the entire copy, so peak residency is
 * 2× the body. Releasing each chunk right after it is copied makes the
 * already-copied prefix collectable, so the peak trends towards 1×.
 * `chunks` is consumed (emptied) — callers must not reuse it.
 */
export function concatAndRelease(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  // Reverse once so `pop()` yields the chunks in their original order while
  // shrinking the array — O(1) per chunk, and the reference is gone immediately.
  chunks.reverse();
  for (let chunk = chunks.pop(); chunk !== undefined; chunk = chunks.pop()) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Stream-read a Request body into a Uint8Array, refusing the read if
 * the cumulative size crosses `maxBytes`. Returns `"exceeded"` if the
 * cap was hit, the bytes otherwise. We never materialise an
 * over-budget body — the read is cancelled the moment the limit is
 * crossed.
 *
 * Shared by the `/mcp` envelope cap (`mcp.ts`) and the `/llm`
 * request-body cap (`app.ts` via `bufferLlmBodyBounded`).
 */
export async function readRequestBodyBounded(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array | "exceeded"> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel();
        return "exceeded";
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return concatAndRelease(chunks, total);
}

export type {
  SidecarConfig,
  LlmProxyConfig,
  LlmProxyApiKeyConfig,
  LlmProxyOauthConfig,
  ModelSwap,
} from "@appstrate/core/sidecar-types";

// The credentials payload the sidecar receives over HTTP is
// wire-identical to what the platform's `/api/credential-proxy/proxy`
// route resolves from the DB — both are `ProxyCredentialsPayload`. The
// local alias keeps call sites readable (this is the HTTP response
// body from `/internal/integration-credentials/{scope}/{name}`).
export type { ProxyCredentialsPayload as CredentialsResponse } from "@appstrate/connect/proxy-primitives";

// Import from the dedicated subpath so the compiled sidecar binary does
// NOT pull `@appstrate/connect`'s credentials module (which transitively
// depends on @appstrate/db — unwanted in a credential-isolating proxy).
export {
  substituteVars,
  findUnresolvedPlaceholders,
  HOP_BY_HOP_HEADERS,
  filterHeaders,
  applyInjectedCredentialHeader,
  normalizeAuthSchemeTemplates,
  withIdleBound,
  STREAM_IDLE,
} from "@appstrate/connect/proxy-primitives";

// `matchesAuthorizedUri` (`(url, patterns[])` allowlist check, AFPS spec
// `*`/`**` semantics) and `stripUserInfoAndFragment` (WHATWG-style URL
// sanitisation used on redirect hops + the `finalUrl` envelope) are
// single-sourced from the shared outbound-HTTP engine in
// `@appstrate/afps-runtime/resolvers` — the same module the sidecar's
// `executeApiCall` redirect-follower uses, so allowlist matching can never
// drift between the preflight here and the per-hop checks there.
export { matchesAuthorizedUri, stripUserInfoAndFragment } from "@appstrate/afps-runtime/resolvers";
