// SPDX-License-Identifier: Apache-2.0

/**
 * The apiShapes the chat can use. API-key families bind to the llm-proxy; the
 * oauth-subscription families are routed (by resolving the model row's provider
 * in chat-stream.ts) to the single generic in-process Pi chat engine instead of
 * the proxy:
 *   - `anthropic-messages` + an oauth `claude-code` credential → Pi chat engine.
 *   - `openai-codex-responses` (codex) → Pi chat engine.
 *
 * The Pi chat engine drives `@earendil-works/pi-coding-agent` in-process; pi-ai
 * emits each provider's subscription request shape natively from the real token
 * (anthropic detects `sk-ant-oat`; codex decodes `chatgpt_account_id`), so the
 * platform forges nothing.
 *
 * Shared by the server-side picker (`llm.ts`) and the client model picker
 * (`ui/models-data.ts`) so the two filters can never drift. Kept dependency-
 * free so importing it into the browser bundle pulls in nothing else — which
 * is also why this is a literal set rather than one derived from a shared
 * constant elsewhere.
 *
 * This is a strict SUPERSET of the proxy-routed families, by design: it answers
 * "can the chat use this family at all?" (= proxy-routed ∪ Pi-engine
 * subscription), a different question from "does the llm-proxy route it?". The
 * extra member today is `openai-codex-responses`. The superset relation is
 * enforced by `test/chat-families.test.ts` — a proxy family missing from this
 * set would be filtered out by `pickModel` before a binding could be built.
 *
 * The other side of that relation now lives in `LLM_PROXY_ROUTES`
 * (`@appstrate/runner-pi`), NOT in a private switch in this package: the drift
 * this guards against is a row added to that table, in another package, which
 * no reviewer of a `module-chat` change will be looking at. This used to point
 * at `pi-chat/model-binding.ts`'s `proxyBaseUrl()` — deleted when the three
 * copies of the path convention were consolidated.
 */
export const CHAT_USABLE_FAMILIES = new Set([
  "openai-completions",
  "anthropic-messages",
  "mistral-conversations",
  "openai-codex-responses",
]);
