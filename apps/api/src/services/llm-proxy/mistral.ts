// SPDX-License-Identifier: Apache-2.0

/**
 * Mistral-conversations adapter — an OpenAI-compatible wire shape.
 *
 * The pi-ai registry tags Mistral models as `mistral-conversations`, but
 * the underlying request flow is plain `POST /v1/chat/completions`
 * against `https://api.mistral.ai` (the `@mistralai/mistralai` SDK's
 * `chat.stream(...)` targets the chat-completions endpoint, NOT Mistral's
 * Beta `/v1/conversations` agentic API). Wire format is the snake_case
 * OpenAI shape — `{ prompt_tokens, completion_tokens, total_tokens }` on
 * usage, SSE usage on the terminal frame.
 *
 * No inbound headers are forwarded (Mistral has no equivalent of
 * `openai-organization` / `openai-beta`; the SDK's `x-affinity` sticky
 * header has no effect once the platform terminates auth).
 *
 * No prompt cache details — Mistral doesn't surface a `cached_tokens`
 * field, so the cache-token branch stays off.
 */

import { createOpenAICompatibleAdapter } from "./openai.ts";

export const mistralConversationsAdapter = createOpenAICompatibleAdapter({
  apiShape: "mistral-conversations",
});
