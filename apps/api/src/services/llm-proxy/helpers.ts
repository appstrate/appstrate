// SPDX-License-Identifier: Apache-2.0

/**
 * Shared body-manipulation helpers for `/api/llm-proxy/*` adapters.
 *
 * Every protocol family the proxy supports today (OpenAI Chat
 * Completions, Anthropic Messages, Mistral Chat Completions) speaks JSON
 * with a top-level `model` and a `usage` object, and streams via SSE
 * `data: {…}` frames. The transport-level mechanics — JSON parse,
 * `body.model` rewrite, SSE frame extraction — are identical across
 * adapters. Centralising them here keeps each adapter focused on the
 * truly protocol-specific bits (which fields to read out of `usage`,
 * which headers to forward).
 *
 * Adapter-specific behaviour stays in the adapter:
 *   - which usage fields to read (`prompt_tokens` vs `input_tokens`, …)
 *   - which auth header to inject (`Authorization` vs `x-api-key`)
 *   - which inbound headers to forward (`anthropic-beta`, `openai-beta`, …)
 *
 * The `parseSseDataFrame` helper filters out OpenAI's `[DONE]`
 * terminator. Anthropic never emits that terminator, so the filter is a
 * no-op there — keeping a single shared helper rather than two near-
 * duplicates.
 */

import { parseSseFrames, parseSseJsonData } from "@appstrate/core/sse";
import { invalidRequest } from "../../lib/errors.ts";

/**
 * Bound on how long an LLM upstream may take to produce its RESPONSE HEADERS
 * on a STREAMING call. Passed as `guardedFetch`'s `timeoutMs`, whose contract
 * is exactly this: it "covers the redirect chain up to the final response's
 * HEADERS … the timer is detached once the response is returned", so a slow
 * but healthy body is never aborted by it.
 *
 * 60 s: a provider asked for `stream: true` emits its first SSE frame within
 * seconds; 60 s is roughly 10× the worst honest TTFB we have observed and
 * still far inside a chat turn's patience. Before this, `timeoutMs` was 0 —
 * no deadline at all, "the caller's disconnect remains the effective bound" —
 * which meant a browser tab left open held a dead upstream connection
 * indefinitely.
 *
 * Deliberately IDENTICAL to the sidecar's `LLM_FIRST_RESPONSE_TIMEOUT_MS`
 * (`runtime-pi/sidecar/helpers.ts`): same concept, same number, so an operator
 * reading a timeout in one log does not have to ask which proxy produced it.
 * See {@link LLM_STREAM_IDLE_TIMEOUT_MS} for why the two files duplicate
 * rather than share.
 */
export const LLM_FIRST_RESPONSE_TIMEOUT_MS = 60_000;

/**
 * Bound on how long a NON-STREAMING upstream may take to produce its response
 * headers. This is the case the previous `timeoutMs: 0` existed to protect:
 * with `stream: false` the provider holds the headers for the ENTIRE
 * generation, so the TTFB bound above would cut off any completion longer than
 * a minute.
 *
 * 10 min matches the non-streaming default of the vendor SDKs themselves
 * (OpenAI and Anthropic both default to a 600 s request timeout and warn above
 * it), so nothing that a direct SDK call would have completed is refused here
 * — while a genuinely dead connection still gets reclaimed instead of living
 * as long as the caller's socket.
 *
 * The sidecar has no twin for this constant on purpose: its `/llm/*` clients
 * are pi-ai provider adapters, which always send `stream: true`.
 */
export const LLM_NON_STREAMING_TIMEOUT_MS = 600_000;

/**
 * Bound on INTER-CHUNK silence once an SSE response is flowing: how long the
 * upstream may say nothing between two body chunks before the proxy declares
 * the stream dead. Enforced in `guardSseTeardown` (`./metering.ts`), because
 * no fetch-level signal can express "silent for 2 min" without also capping
 * the total duration.
 *
 * This is the bound that fixes the reported bug. Pi's SDK passes a `timeoutMs`
 * down to its provider adapters, but four of the api shapes this platform maps
 * ignore it entirely (`google-generative-ai`, `google-vertex`,
 * `bedrock-converse-stream`, `pi-messages` — grep `timeoutMs` in
 * `@earendil-works/pi-ai/dist/api/*.js`, they honour only `options.signal`).
 * A stalled Gemini/Vertex/Bedrock stream was bounded by nothing at all on this
 * path. An Appstrate-owned proxy is the only provider-agnostic place that
 * covers all four shapes.
 *
 * 120 s, i.e. looser than the first-response bound: once a provider has
 * started streaming, a long pause is a real (if rare) event — extended
 * thinking and large parallel tool-call payloads routinely buy 15-45 s of
 * silence.
 *
 * DUPLICATED, not shared, with `runtime-pi/sidecar/helpers.ts`. Both packages
 * could import from `@appstrate/core`, but core is published to npm under a
 * consumer-lockstep release gate — adding a subpath export there costs a
 * version bump, a publish and a bump in every out-of-tree consumer, for two
 * integers. The sidecar also deliberately keeps its transport timings local
 * (`LLM_PROXY_TIMEOUT_MS`, `OUTBOUND_TIMEOUT_MS` live in its own `helpers.ts`)
 * because it is boot-latency sensitive. Keep the two definitions in sync by
 * hand; each names the other.
 */
export const LLM_STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * Parsed shape of an inbound `/api/llm-proxy/*` request body. Built
 * once at the start of the pipeline so the preset extraction, the
 * streaming detection, and the upstream model rewrite all share a
 * single `JSON.parse` over the raw bytes.
 */
interface ParsedProxyRequest {
  /** Caller-supplied preset id (the value of `body.model`). */
  presetId: string;
  /** True iff `body.stream === true`. */
  stream: boolean;
  /**
   * Produce a fresh body byte sequence with `model` swapped for
   * `upstreamModelId`. The optional `mutate` callback receives the parsed body
   * right before re-encoding — the seam the protocol adapter uses to force
   * usage reporting on (`LlmProxyAdapter.forceUsageReporting`). The rest of the
   * payload is preserved.
   */
  rewriteModel(
    upstreamModelId: string,
    mutate?: (body: Record<string, unknown>) => void,
  ): Uint8Array;
}

/**
 * Parse a `/api/llm-proxy/*` request body once. Throws `invalidRequest`
 * if the payload isn't a JSON object with a non-empty `model` field —
 * the proxy can't route a request without a preset id.
 */
export function parseProxyRequest(rawBody: Uint8Array): ParsedProxyRequest {
  const text = new TextDecoder().decode(rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidRequest("Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const model = obj["model"];
  if (typeof model !== "string" || model.length === 0) {
    throw invalidRequest("Request body must include a non-empty `model` field");
  }
  return {
    presetId: model,
    stream: obj["stream"] === true,
    rewriteModel(
      upstreamModelId: string,
      mutate?: (body: Record<string, unknown>) => void,
    ): Uint8Array {
      obj["model"] = upstreamModelId;
      mutate?.(obj);
      return new TextEncoder().encode(JSON.stringify(obj));
    },
  };
}

/** Pull `body.usage` out of a parsed JSON response. Returns null if absent or malformed. */
export function extractUsageObject(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const u = (body as Record<string, unknown>)["usage"];
  if (!u || typeof u !== "object") return null;
  return u as Record<string, unknown>;
}

/** Coerce an unknown value into a finite number, or undefined. */
function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Coerce an unknown value into a finite token COUNT — a non-negative number —
 * or undefined when the field is absent/unparseable.
 *
 * A token bucket is priced as `count × rate`, so a negative count reported by a
 * misbehaving upstream would produce a NEGATIVE `cost_usd`: it would *reduce*
 * the run's cost (`computeRunSpend` SUMs the ledger) and, on a system-credential
 * row, the corresponding debit. Nothing downstream re-checks the sign (there is
 * no CHECK on `llm_usage.cost_usd`), so the floor is applied here, at the single
 * point where wire numbers enter the accounting path. Every adapter reads token
 * fields through this helper — never through {@link numberOrUndefined}.
 */
export function tokenCount(v: unknown): number | undefined {
  const n = numberOrUndefined(v);
  return n === undefined ? undefined : Math.max(0, n);
}

/**
 * Extract the JSON payload of an SSE `data: …` frame block (one frame,
 * already split on the blank-line delimiter). Returns null on the OpenAI
 * `[DONE]` terminator or unparseable JSON. Thin wrapper over the shared
 * `@appstrate/core/sse` primitives.
 */
export function parseSseDataFrame(chunk: string): unknown | null {
  const { frames } = parseSseFrames(chunk + "\n\n", "");
  const frame = frames[0];
  return frame ? parseSseJsonData(frame.data) : null;
}
