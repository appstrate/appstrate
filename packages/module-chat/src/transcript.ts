// SPDX-License-Identifier: Apache-2.0

/**
 * Flatten an assistant-ui `UIMessage[]` thread into a single prompt string —
 * shared by the engines that drive a binary which takes a prompt, not a
 * structured message array (the codex CLI and the Claude Agent SDK).
 *
 * A single user turn is sent verbatim; multiple turns become a labelled
 * `User:`/`Assistant:` transcript so a stateless driver gets the full
 * conversational context. Non-text parts (tool calls, files) are dropped — only
 * text survives into the transcript. An optional `system` persona is prepended
 * (the codex CLI takes no separate system arg; the Claude SDK does, so it omits
 * it here and passes system through the SDK instead).
 */

import type { UIMessage } from "ai";

export function buildTranscriptPrompt(messages: UIMessage[], opts?: { system?: string }): string {
  const textOf = (m: UIMessage): string =>
    (m.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim();

  const turns = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, text: textOf(m) }))
    .filter((t) => t.text.length > 0);

  const transcript =
    turns.length === 0
      ? ""
      : turns.length === 1
        ? turns[0]!.text
        : turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n");

  const system = opts?.system;
  return system ? `${system}\n\n---\n\n${transcript}` : transcript;
}
