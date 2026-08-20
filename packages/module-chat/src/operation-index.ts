// SPDX-License-Identifier: Apache-2.0

/**
 * Shared system-prompt policy for the trailing operation index (fenced by
 * {@link OPERATION_INDEX_HEADING}) — applied by the chat engine to the system
 * prompt it assembles, per API shape.
 */

import { OPERATION_INDEX_HEADING } from "@appstrate/core/chat-contract";

/**
 * Strip the trailing operation index from the system prompt for providers
 * without a prompt cache, where the multi-KB index would be re-sent uncached on
 * every step: Mistral, and codex (the chatgpt.com backend is not prompt-cached
 * the way Anthropic/OpenAI are). Everyone else keeps it. Tools are unaffected —
 * the agent always has search_operations for discovery when the index is absent.
 */
export function applyOperationIndexPolicy(system: string, apiShape: string): string {
  const drop = apiShape === "mistral-conversations" || apiShape === "openai-codex-responses";
  if (drop && system.includes(OPERATION_INDEX_HEADING)) {
    return system.slice(0, system.indexOf(OPERATION_INDEX_HEADING)).trimEnd();
  }
  return system;
}
