// SPDX-License-Identifier: Apache-2.0

/**
 * Model-alias swap: callers see a vanity id (`alias`); the real upstream id
 * (`real`) stays server-side. Requests are rewritten alias→real and responses
 * real→alias, in JSON and in SSE, by both the sidecar proxy (`runtime-pi/sidecar`)
 * and the platform gateway (`apps/api`, `/api/llm-proxy/*`). Matching is by exact
 * value at known JSON locations, never a blind replace.
 */

import type { ModelApiShape, ModelSwap } from "./sidecar-types.ts";

/**
 * The protocols an alias can be BACKED by. Only these carry the model id in the
 * request BODY; url-model shapes cannot back an alias.
 */
const ALIAS_BACKING_SHAPES = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
] as const satisfies readonly ModelApiShape[];

/** A protocol an alias can be BACKED by — never one a client speaks. */
export type AliasBackingApiShape = (typeof ALIAS_BACKING_SHAPES)[number];

export function isAliasBackingShape(shape: ModelApiShape): shape is AliasBackingApiShape {
  return (ALIAS_BACKING_SHAPES as readonly ModelApiShape[]).includes(shape);
}

/**
 * The protocol an ALIASED run's container speaks — pi-ai's vendor-neutral
 * `pi-messages`. `buildRuntimePiEnv` emits it as `MODEL_API` and the launcher
 * stamps it on `ModelSwap.clientApiShape`; split the two and the sidecar's inbound
 * allowlist refuses every call the container makes.
 */
export const ALIAS_CLIENT_API_SHAPE: ModelApiShape = "pi-messages";

export function isAliasClientShape(shape: ModelApiShape): boolean {
  return shape === ALIAS_CLIENT_API_SHAPE;
}

// Sidecar boot pins `clientApiShape` to the client dialect, so one path is exact.
const ALIAS_INFERENCE_PATH = "/messages";

/**
 * True when `(method, path)` is exactly the inference call an aliased client
 * makes — the allowlist that narrows an ALIASED run's `/llm/*` surface. Without
 * it, `GET <MODEL_BASE_URL>/v1/models` returns the vendor catalogue in a 2xx body
 * that neither the error synthesis nor the field rewrite touches. Fails closed:
 * the path is matched whole, never by prefix.
 */
export function isAliasInferenceCall(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && path === ALIAS_INFERENCE_PATH;
}

/**
 * Reason an aliased model fails its configuration invariants, or `null`:
 *   - `missing_label` — a derived label names the real backing, leaking it on
 *     `/api/models` and `run.model_label`.
 *   - `non_aliasable_shape` — model id in the URL, or the client-only dialect.
 *   - `oauth_provider` — the oauth `/llm` mode is a pure bearer-swap carrying no
 *     `modelSwap`, so an alias there could never be swapped.
 */
export type AliasInvariantViolation = "missing_label" | "non_aliasable_shape" | "oauth_provider";

/**
 * The alias invariants, shared by the two boundaries that accept one: the
 * env-seeded registry (skips on violation) and `POST /api/models` (rejects).
 */
export function checkAliasInvariants(input: {
  label?: string | null;
  apiShape: ModelApiShape;
  authMode: "api_key" | "oauth2";
}): AliasInvariantViolation | null {
  if (!input.label) return "missing_label";
  if (!isAliasBackingShape(input.apiShape)) return "non_aliasable_shape";
  if (input.authMode === "oauth2") return "oauth_provider";
  return null;
}

/** Rewrite the known `model` locations real→alias in a parsed object (mutates). */
function rewriteModelRealToAlias(obj: unknown, swap: ModelSwap): void {
  if (!obj || typeof obj !== "object") return;
  const o = obj as Record<string, unknown>;
  if (o["model"] === swap.real) o["model"] = swap.alias;
  // `message` (Anthropic `message_start`) and `response` (OpenAI Responses
  // events) are one-level nestings that also hold the model id.
  for (const key of ["message", "response"] as const) {
    const nested = o[key];
    if (nested && typeof nested === "object") {
      const n = nested as Record<string, unknown>;
      if (n["model"] === swap.real) n["model"] = swap.alias;
    }
  }
}

export function swapResponseModelJson(bodyText: string, swap: ModelSwap): string {
  try {
    const obj = JSON.parse(bodyText);
    rewriteModelRealToAlias(obj, swap);
    return JSON.stringify(obj);
  } catch {
    return bodyText;
  }
}

/**
 * The only response headers forwarded from an upstream LLM provider: content type,
 * `retry-after` / `RateLimit*`, `x-request-id`. The rest fingerprint the backing.
 */
export const LLM_PASSTHROUGH_RESPONSE_HEADERS: readonly string[] = [
  "content-type",
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
  "x-request-id",
];

/**
 * Neutral prose for every synthesized alias error; upstream detail stays in the
 * log. FIXED text — nothing is interpolated into it but a status from the
 * enumerated forwardable set, because both classifiers that read it are
 * substring matchers (see {@link syntheticAliasClassifierMessage}).
 */
const ALIAS_UPSTREAM_ERROR_MESSAGE = "Upstream model error";

/**
 * The only upstream statuses an aliased response may carry, and how the rest
 * are collapsed.
 *
 * Every status is judged on TWO INDEPENDENT axes, and a change that trades one
 * for the other is not a fix:
 *
 * 1. VENDOR IDENTITY — may the number be disclosed at all? A status normally
 *    describes the TRANSACTION, not the backing: every candidate backing
 *    ({@link ALIAS_BACKING_SHAPES} — `anthropic-messages`,
 *    `openai-completions`, `openai-responses`, `openai-codex-responses`,
 *    `mistral-conversations`) answers 429 when throttled and 400 on a bad
 *    request, so forwarding one costs no opacity. A status only SOME of them
 *    can answer is different: it names the backing as surely as the prose this
 *    boundary scrubs. Those are collapsed.
 *
 * 2. RETRYABILITY — what may the number be collapsed TO? TWO classifiers read
 *    this text, and a status is only correct on this axis when BOTH agree:
 *
 *      - pi-ai's `isRetryableAssistantError` (the container's in-turn retry
 *        budget), a regex over the message text. Its
 *        `RETRYABLE_PROVIDER_ERROR_PATTERN` matches the status literals `429`,
 *        `500`, `502`, `503`, `504` and `524`; no other 4xx matches anything
 *        in it, and its `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` keys on
 *        words ("billing", "quota exceeded", "insufficient_quota", …) this
 *        boundary has already replaced with "Upstream model error".
 *      - the platform's own `classifyModelError` (`./model-error`), which
 *        drives `run_logs.data.error_retryable` on the run trail and the chat
 *        surface's retry affordance through `classifyClientTurnError`. It
 *        reads the `(status N)` hint — via `\b[45]\d\d\b` when no envelope
 *        status was unwrapped — and treats the STATUS as authoritative over
 *        the prose around it: any 4xx is terminal, any 5xx transient.
 *
 *    The projected status is the ONLY thing left in that text once the
 *    vendor's prose is replaced, so the collapse TARGET decides retryability,
 *    and one target cannot serve both kinds of failure: collapsing a permanent
 *    failure to `502` has the container retry to exhaustion a request that can
 *    never succeed, while forwarding a vendor-identifying code just to keep it
 *    terminal re-opens axis 1.
 *
 * Hence two targets, picked by the CLASS of the status being collapsed: a 4xx
 * becomes {@link ALIAS_COLLAPSED_TERMINAL_UPSTREAM_STATUS} (400 — matched by
 * neither pi-ai pattern, so terminal) and anything else becomes
 * {@link ALIAS_COLLAPSED_TRANSIENT_UPSTREAM_STATUS} (502 — retryable). The
 * class is the upstream's own verdict on whether re-sending the identical
 * request could ever help, so the projection preserves it rather than
 * overriding it with whatever the collapse target happens to mean.
 *
 * How each status was judged:
 *
 *   - `400` `401` `403` `404` `408` `409` `429` `500` `502` `503` `504` —
 *     FORWARDED. Generic on axis 1 (every candidate answers them alike), and
 *     verbatim forwarding is exact on axis 2 by construction.
 *   - `405` `413` `415` — FORWARDED. These are verdicts on the request's HTTP
 *     framing (method, body size, media type), not entries in a model API's
 *     error vocabulary: any HTTP server can answer them and no candidate is
 *     singled out by one, so axis 1 is clean. All three are terminal when
 *     forwarded, on both classifiers, which is the right verdict for an
 *     oversized prompt or an unsupported media type — so axis 2 is clean too.
 *
 *     Checked, not assumed: `no substring of "status 413" is in either pi-ai
 *     pattern` was only ever half the answer, and the half it left out was
 *     wrong. `classifyModelError` used to read the fixed words "Upstream model
 *     error" as a transient 5xx and hand `404` `405` `408` `409` `413` `415` —
 *     every forwardable status it did not name explicitly — back to the
 *     retryable side, so the exact failure this bullet cites (an oversized
 *     prompt, retried to the max on a request that can never succeed) was
 *     fixed on the pi-ai path and left live on the platform's own. It now
 *     classifies by the status: 4xx terminal, 5xx transient. Both classifiers
 *     are pinned to agree over all fourteen forwardable statuses by
 *     `packages/core/test/model-error.test.ts`.
 *   - `402` — COLLAPSED. Anthropic, OpenAI and Mistral have no 402 in their
 *     error vocabulary; an aggregating gateway out of credit (OpenRouter) does,
 *     so the number names the backing. The failure is permanent and 400 keeps
 *     it permanent — which is also the only signal left, since the words
 *     `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` keys on are exactly the ones
 *     this boundary scrubs.
 *   - `422` — COLLAPSED. Mistral answers 422 for request-validation failures
 *     where Anthropic and OpenAI answer 400, so 422-vs-400 partitions the
 *     candidates. 400 is both the verdict the others give for the same failure
 *     and terminal.
 *   - `431` — COLLAPSED. A front-end / CDN code (request headers too large),
 *     the same class of tell as `520`–`526`: the model API does not emit it,
 *     the edge in front of it does. Permanent, and 400 keeps it permanent.
 *   - `529`, `520`–`526` — COLLAPSED, the original reason: `529` is Anthropic's
 *     own overload code and `520`–`526` say the backing sits behind Cloudflare.
 *     Both are 5xx and genuinely transient, so 502 hides the tell AND keeps the
 *     container's retry.
 *
 * The set stays an allowlist: the space of vendor- and CDN-specific codes is
 * unenumerable, so a code nobody has seen must default to opaque rather than to
 * disclosed — and the class-based target makes that default right on axis 2 as
 * well, since an unknown 4xx then fails fast and an unknown 5xx is retried.
 * When adding one, check it against BOTH axes.
 */
const FORWARDABLE_UPSTREAM_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 405, 408, 409, 413, 415, 429, 500, 502, 503, 504,
]);

/**
 * Collapse target for a TRANSIENT upstream failure: a generic "the upstream hop
 * failed" with no vendor in it, and retryable under pi-ai's classifier.
 */
export const ALIAS_COLLAPSED_TRANSIENT_UPSTREAM_STATUS = 502;

/**
 * Collapse target for a PERMANENT upstream failure: a generic "that request was
 * not acceptable", matched by neither pi-ai pattern, so the container fails
 * fast instead of re-sending a request that can never succeed.
 */
export const ALIAS_COLLAPSED_TERMINAL_UPSTREAM_STATUS = 400;

/**
 * Project an upstream status onto the aliased surface. Both boundaries that
 * replace an upstream failure — the sidecar's re-originated `pi-messages`
 * error event and the platform gateway's synthesized response — MUST call this
 * before disclosing a status, or the code itself fingerprints the vendor that
 * the body was scrubbed to hide.
 *
 * A collapsed 4xx becomes 400 and a collapsed anything-else becomes 502, so
 * making a status opaque never also makes a permanent failure retryable.
 */
export function projectAliasUpstreamStatus(status: number): number {
  if (FORWARDABLE_UPSTREAM_STATUSES.has(status)) return status;
  return status >= 400 && status < 500
    ? ALIAS_COLLAPSED_TERMINAL_UPSTREAM_STATUS
    : ALIAS_COLLAPSED_TRANSIENT_UPSTREAM_STATUS;
}

/**
 * True when `status` may be interpolated into a message a retry classifier
 * reads. The guard is the FORWARDABLE set itself, which makes the integers
 * that can appear in {@link syntheticAliasClassifierMessage} a closed,
 * auditable list of fourteen — not "whatever a caller passed". Every caller
 * already passes either a {@link projectAliasUpstreamStatus} result or a
 * gateway status of its own, so this never fires in practice; it is here so
 * that a future caller cannot widen the token set by accident.
 */
function isDisclosableAliasStatus(status: number | undefined): status is number {
  return status !== undefined && FORWARDABLE_UPSTREAM_STATUSES.has(status);
}

/**
 * CLASSIFIER SIDE of the alias boundary: the neutral string an aliased failure
 * puts in a field that a RETRY CLASSIFIER reads — pi-ai's `errorMessage` on a
 * `pi-messages` error event, and the `error.message` of
 * {@link syntheticAliasErrorBody}.
 *
 * **It takes no {@link ModelSwap}, and that is the whole design.** pi-ai's
 * `isRetryableAssistantError` is a case-insensitive substring alternation over
 * exactly this text — `429`, `500`, `502`, `503`, `504`, `524`, `overloaded`,
 * `rate.?limit`, the timeout family — and the platform's own
 * `classifyModelError` reads a `\b[45]\d\d\b` out of it. An alias is
 * ORG-CONTROLLED text. Interpolated here, `gpt-500-fast` (not a contrived
 * name) made every failure on that alias retryable, terminal `400` included:
 * the org, not the transaction, decided the retry verdict. Sanitizing the
 * alias against the classifier's keywords would couple this file to pi-ai's
 * internals and rot the moment they add a pattern, so the alias is not here to
 * sanitize.
 *
 * **Pass `status` wherever one is known.** It looks like decoration and is not:
 * this string is the ONLY channel a caller has left to classify the failure,
 * because the body it replaced is gone. Omit the status and every aliased
 * failure reads as permanent, so a `429` that the same model on a BYOK
 * credential rides out fails the run instead. Disclosing the integer costs no
 * opacity — a status describes the TRANSACTION, not the backing, and
 * {@link projectAliasUpstreamStatus} has already collapsed the codes that
 * would name one. What stays replaced is the vendor's prose: model ids,
 * hostnames, provider vocabulary, rate-limit copy.
 */
export function syntheticAliasClassifierMessage(status?: number): string {
  const statusHint = isDisclosableAliasStatus(status) ? ` (status ${status})` : "";
  return `${ALIAS_UPSTREAM_ERROR_MESSAGE}${statusHint}`;
}

/**
 * WIRE SIDE of the alias boundary: the caller-facing body replacing a non-2xx
 * upstream response on an ALIASED model. Nothing from upstream survives, only
 * the projected status code and {@link LLM_PASSTHROUGH_RESPONSE_HEADERS}.
 * Carries both family discriminators (`type: "error"` and `error.message`) so
 * one shape parses in either SDK.
 *
 * The alias lives in `error.model`, NOT inside `error.message` — an operator
 * still reads which model failed, and the sentence a classifier consumes stays
 * free of org-controlled text. That split is not cosmetic: this body reaches
 * the chat surface's `classifyClientTurnError`, whose status regex matched the
 * `500` in an alias named `gpt-500-fast` and read a terminal `400` as a
 * retryable outage. A structured field cannot be mistaken for prose.
 */
export function syntheticAliasErrorBody(swap: ModelSwap, status?: number): string {
  return JSON.stringify({
    type: "error",
    error: {
      type: "upstream_error",
      message: syntheticAliasClassifierMessage(status),
      model: swap.alias,
    },
  });
}

function isErrorObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// An error frame is Anthropic's `{"type":"error"}`, an OpenAI-family top-level
// `error` object, or the OpenAI Responses nesting `{"response":{"error":{…}}}`.
// The `choices` guard keeps a hybrid frame that also carries generated content on
// the exact-field path, so content is never replaced.
function isSseErrorFrame(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o["type"] === "error") return true;
  if (isErrorObject(o["error"]) && !("choices" in o)) return true;
  const response = o["response"];
  return isErrorObject(response) && isErrorObject((response as Record<string, unknown>)["error"]);
}

function rewriteSseLine(line: string, swap: ModelSwap): string {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice("data:".length).trimStart();
  // Fast skip: [DONE] and chunks naming neither the real id nor `"error"` need no
  // parse. A false positive on the probe costs a parse, never a wrong rewrite.
  if (payload === "[DONE]" || (!payload.includes(swap.real) && !payload.includes(`"error"`))) {
    return line;
  }
  try {
    const obj = JSON.parse(payload);
    // Error frames name the backing in free-form prose, so they are replaced
    // wholesale; they carry no generated content, so the caller loses nothing.
    if (isSseErrorFrame(obj)) {
      return `data: ${syntheticAliasErrorBody(swap)}`;
    }
    rewriteModelRealToAlias(obj, swap);
    return `data: ${JSON.stringify(obj)}`;
  } catch {
    return line;
  }
}

/**
 * Streaming (SSE) transform: rewrite `model` real→alias in each `data:` frame.
 * Line-buffered so a frame split across chunk boundaries is still rewritten.
 */
export function createSseModelSwapStream(swap: ModelSwap): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const newlineEnd = buffer.lastIndexOf("\n");
      if (newlineEnd === -1) return; // no complete line yet — keep buffering
      const ready = buffer.slice(0, newlineEnd + 1);
      buffer = buffer.slice(newlineEnd + 1);
      // `ready` ends in "\n", so split's last element is "" and rewriteSseLine
      // returns it untouched — hence no trailing-element guard.
      const rewritten = ready
        .split("\n")
        .map((line) => rewriteSseLine(line, swap))
        .join("\n");
      controller.enqueue(encoder.encode(rewritten));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewriteSseLine(buffer, swap)));
    },
  });
}
