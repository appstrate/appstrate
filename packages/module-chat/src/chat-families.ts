// SPDX-License-Identifier: Apache-2.0

/**
 * The apiShapes the chat can use: API-key families only. `claude-code` is
 * selectable via its `anthropic-messages` apiShape but is routed to the Claude
 * Agent SDK engine (by `providerId`, in chat-stream.ts), NOT the proxy.
 *
 * Codex is deliberately excluded. It is an OAuth-subscription provider with no
 * fingerprint-forging path and no official SDK driver, so — exactly like a
 * codex agent run — it has no usable chat path and must surface a clear error
 * rather than a grey 404 dead-route. The codex guard in `chat-stream.ts`
 * enforces this even if a codex preset id is requested directly; the
 * run-launcher's `assertRunnableOnEngine` is the run-side mirror.
 *
 * Shared by the server-side picker (`llm.ts`) and the client model picker
 * (`ui/model-select.tsx`) so the two filters can never drift. Kept dependency-
 * free so importing it into the browser bundle pulls in nothing else.
 */
export const CHAT_USABLE_FAMILIES = new Set([
  "openai-completions",
  "anthropic-messages",
  "mistral-conversations",
]);

/** apiShape of the codex OAuth-subscription provider — never usable in chat. */
export const CODEX_API_SHAPE = "openai-codex-responses";
