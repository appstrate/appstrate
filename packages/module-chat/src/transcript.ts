// SPDX-License-Identifier: Apache-2.0

/**
 * Flatten an assistant-ui `UIMessage[]` thread into a single prompt string —
 * used by the in-process Pi subscription chat engine, whose `session.prompt()`
 * takes a prompt string rather than a structured message array.
 *
 * A single user turn is sent verbatim; multiple turns become a labelled
 * `User:`/`Assistant:` transcript so a stateless driver gets the full
 * conversational context. Tool-call parts are dropped — only text survives into
 * the transcript. File attachments are first flattened into model-facing text
 * lines ({@link messagesWithAttachmentsAsText}), so a `document://` the user
 * attached reaches the model here exactly as it does on the ai-sdk path. The
 * system persona is NOT prepended here: the caller (the Pi chat engine) passes
 * system through the session's own system-prompt arg.
 *
 * KNOWN LIMITATION (lossy vs the ai-sdk path): the ai-sdk chat path feeds the
 * model `convertToModelMessages(messages)` — a structured array preserving tool
 * calls, tool results, and file parts. This flattening keeps only text, so a
 * multi-turn, tool-rich session is degraded on the Pi-driven engine. Acceptable
 * for the current chat surface (the session takes a prompt, not a message
 * array); revisit with a structured adapter if/when the session accepts richer
 * multi-part input.
 */

import type { UIMessage } from "ai";
import { uiMessageText } from "./message-text.ts";
import { messagesWithAttachmentsAsText } from "./attachments.ts";

export function buildTranscriptPrompt(messages: UIMessage[]): string {
  const turns = messagesWithAttachmentsAsText(messages)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, text: uiMessageText(m.parts) }))
    .filter((t) => t.text.length > 0);

  const transcript =
    turns.length === 0
      ? ""
      : turns.length === 1
        ? turns[0]!.text
        : turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n");

  return transcript;
}
