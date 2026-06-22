// SPDX-License-Identifier: Apache-2.0

/**
 * The apiShapes the chat can use. API-key families bind to the llm-proxy; the
 * Claude subscription family is routed (by `providerId`, in chat-stream.ts) to
 * its own engine instead of the proxy:
 *   - `anthropic-messages` + providerId `claude-code` → Claude Agent SDK engine.
 *
 * The Claude subscription engine drives the vendor's official binary (which
 * signs its own client fingerprint) behind a non-forging credential-injection
 * gateway. Codex (ChatGPT) subscriptions are NOT usable in chat — they run only
 * as docker-isolated agents (see docs/architecture/SUBSCRIPTION_COMPLIANCE.md).
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
