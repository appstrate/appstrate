// SPDX-License-Identifier: Apache-2.0

/**
 * The apiShapes the chat can use. API-key families bind to the llm-proxy; the
 * oauth-subscription families are routed (by resolving the model row's provider
 * in chat-stream.ts) to the single generic in-process Pi chat engine instead of
 * the proxy:
 *   - `anthropic-messages` + an oauth `claude-code` credential → Pi chat engine.
 *   - `openai-codex-responses` (codex) → Pi chat engine.
 *
 * The Pi chat engine drives `@mariozechner/pi-coding-agent` in-process; pi-ai
 * emits each provider's subscription request shape natively from the real token
 * (anthropic detects `sk-ant-oat`; codex decodes `chatgpt_account_id`), so the
 * platform forges nothing. Codex is now chat-usable (it was previously
 * chat-excluded when chat only had the Claude Agent SDK engine).
 *
 * Shared by the server-side picker (`llm.ts`) and the client model picker
 * (`ui/models-data.ts`) so the two filters can never drift. Kept dependency-
 * free so importing it into the browser bundle pulls in nothing else.
 */
export const CHAT_USABLE_FAMILIES = new Set([
  "openai-completions",
  "anthropic-messages",
  "mistral-conversations",
  "openai-codex-responses",
]);
