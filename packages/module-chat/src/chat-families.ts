// SPDX-License-Identifier: Apache-2.0

/**
 * The apiShapes the chat can use. API-key families bind to the llm-proxy;
 * subscription families are routed (by `providerId`, in chat-stream.ts) to their
 * own ToS-clean engine instead of the proxy:
 *   - `anthropic-messages` + providerId `claude-code` → Claude Agent SDK engine.
 *   - `openai-codex-responses` + providerId `codex`   → Codex CLI engine.
 *
 * Both subscription engines drive the vendor's official binary (which signs its
 * own client fingerprint) behind a non-forging credential-injection gateway.
 *
 * Shared by the server-side picker (`llm.ts`) and the client model picker
 * (`ui/model-select.tsx`) so the two filters can never drift. Kept dependency-
 * free so importing it into the browser bundle pulls in nothing else.
 */
export const CHAT_USABLE_FAMILIES = new Set([
  "openai-completions",
  "anthropic-messages",
  "mistral-conversations",
  "openai-codex-responses",
]);
