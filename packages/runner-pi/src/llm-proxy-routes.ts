// SPDX-License-Identifier: Apache-2.0

/**
 * The llm-proxy's route table — ONE declaration, three readers.
 *
 * The proxy exposes a per-api-shape endpoint that a Pi/vendor client talks to
 * as if it were the real provider. That works only because our base URL mirrors
 * each vendor SDK's own path convention, and those conventions disagree:
 *
 *   - the OpenAI client appends `/chat/completions`, so `/v1` belongs in the
 *     BASE (`https://api.openai.com/v1`);
 *   - the Anthropic client appends `/v1/messages`, so the base is the bare host
 *     (`https://api.anthropic.com`);
 *   - the Mistral transport appends `/v1/chat/completions` — the Anthropic
 *     convention, not the OpenAI one.
 *
 * So `/v1` sits in the base for `openai-completions` and in the suffix for the
 * other two. That looks like an inconsistency and is not one, which is exactly
 * why it kept being copied by hand: the route table in `apps/api`, the chat
 * engine's base-URL builder and the CLI's each spelled the same three strings
 * out separately, each with its own long comment explaining the same rule, and
 * one of them told the reader to "check the result against the route declared
 * in apps/api/src/routes/llm-proxy.ts" — a manual step a shared table removes.
 *
 * This package is the shared home because all three readers already depend on
 * it (`apps/api`, `apps/cli` and `packages/module-chat` all import from
 * `@appstrate/runner-pi` today), and it already owns the neighbouring
 * api-shape ↔ provider mapping.
 *
 * Adding a shape: derive both fields from that client's own path building, and
 * nothing else changes — the proxy route, the chat base URL and the CLI base
 * URL all fall out of the entry.
 */

/** One proxied api shape's path convention. */
// Not exported: `as const satisfies Record<string, LlmProxyRoute>` below keeps
// the literal type, so no consumer ever names this — and knip flags an exported
// type with no reader, which is how the barrel export of it was caught.
interface LlmProxyRoute {
  /**
   * Path segment that belongs in the BASE URL handed to the vendor client,
   * after `/api/llm-proxy/<apiShape>`. Empty when the client puts the whole
   * versioned path in its own suffix.
   */
  readonly baseSuffix: string;
  /**
   * Path the vendor client appends to that base.
   *
   * It doubles as the path the proxy appends to the REAL upstream base, and
   * that is not a coincidence to be tidied away: it holds precisely because our
   * base mirrors the provider's base convention, which is the whole design. If
   * a future provider breaks that symmetry, split this field rather than
   * bending one of the two call sites.
   */
  readonly sdkPath: string;
}

/**
 * Every api shape the llm-proxy serves. A shape absent here is not proxyable —
 * `openai-codex-responses`, for instance, is oauth-subscription-only and an
 * operator can never point a custom endpoint at it.
 */
export const LLM_PROXY_ROUTES = {
  "openai-completions": { baseSuffix: "/v1", sdkPath: "/chat/completions" },
  "anthropic-messages": { baseSuffix: "", sdkPath: "/v1/messages" },
  "mistral-conversations": { baseSuffix: "", sdkPath: "/v1/chat/completions" },
} as const satisfies Record<string, LlmProxyRoute>;

/** Api shapes the llm-proxy can route, derived from the table itself. */
export type ProxiedApiShape = keyof typeof LLM_PROXY_ROUTES;

/** Whether the llm-proxy serves this api shape. */
export function isProxiedApiShape(apiShape: string): apiShape is ProxiedApiShape {
  return apiShape in LLM_PROXY_ROUTES;
}

/**
 * Base URL a vendor client is pointed at to reach the proxy, or null when the
 * shape is not proxyable.
 *
 * A trailing slash on `origin` is trimmed here rather than required of the
 * caller. The precondition used to be documented and unenforced, and only one
 * of the two callers honoured it: the CLI trimmed its `--instance` value, while
 * chat passed `CHAT_SELF_ORIGIN` — an operator-set env var — verbatim, so
 * `http://127.0.0.1:3000/` produced a double slash. Consolidating three copies
 * of a path convention into one function is the moment to enforce its
 * precondition once too, instead of restating it.
 */
export function llmProxyBaseUrl(origin: string, apiShape: string): string | null {
  if (!isProxiedApiShape(apiShape)) return null;
  const base = origin.replace(/\/+$/, "");
  return `${base}/api/llm-proxy/${apiShape}${LLM_PROXY_ROUTES[apiShape].baseSuffix}`;
}

/**
 * Path the proxy listens on for one shape, relative to the `/api/llm-proxy`
 * mount — i.e. the base suffix plus whatever the client appends to it.
 */
export function llmProxyUrlPath(apiShape: ProxiedApiShape): string {
  const route = LLM_PROXY_ROUTES[apiShape];
  return `/${apiShape}${route.baseSuffix}${route.sdkPath}`;
}
