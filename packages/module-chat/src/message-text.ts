// SPDX-License-Identifier: Apache-2.0

/**
 * Concatenate the text of a UIMessage's `text` parts (all other part kinds —
 * tool calls, files — dropped), trimmed. Accepts the raw `parts` array so it
 * works on both a typed `UIMessage` (transcript building) and a narrowed JSONB
 * `content.parts` read from storage (title derivation).
 */
export function uiMessageText(parts: unknown[] | undefined): string {
  return (parts ?? [])
    .map((p) =>
      p && typeof p === "object" && (p as { type?: string }).type === "text"
        ? ((p as { text?: string }).text ?? "")
        : "",
    )
    .join("")
    .trim();
}
