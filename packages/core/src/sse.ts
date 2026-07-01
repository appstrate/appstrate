// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal SSE (Server-Sent Events) wire-format helpers — the single
 * implementation of frame splitting / `data:` extraction shared by every
 * consumer that hand-parses an SSE stream (the web run-sync reader, the
 * chat module's UI-message stream tee, the LLM proxy's usage extractor).
 *
 * Frame semantics follow the WHATWG EventSource algorithm closely enough
 * for the platform's emitters: frames are separated by a blank line,
 * field lines are `event:` / `data:` (other fields ignored), a trailing
 * `\r` is stripped so CRLF streams parse identically, and multi-line
 * `data:` payloads are joined with `"\n"` per spec.
 */

/** A parsed SSE frame: its `event:` name and concatenated `data:` payload. */
export interface SseFrame {
  /** `event:` field value; `""` when the frame carries none. */
  event: string;
  /** Concatenated `data:` payload (multi-line `data:` joined with `"\n"`). */
  data: string;
}

/**
 * Incremental SSE frame parser for `fetch` + `ReadableStream` readers.
 * Given a freshly-decoded `chunk` and the `buffer` left over from the
 * previous read, it splits on the `\n\n` frame separator, parses complete
 * frames, and returns the new leftover buffer (an incomplete trailing
 * frame, if any). Pass the returned `buffer` back in on the next chunk.
 */
export function parseSseFrames(
  chunk: string,
  buffer: string,
): { frames: SseFrame[]; buffer: string } {
  const combined = buffer + chunk;
  const parts = combined.split("\n\n");
  const rest = parts.pop()!;

  const frames: SseFrame[] = [];
  for (const part of parts) {
    let event = "";
    const data: string[] = [];
    for (const rawLine of part.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    frames.push({ event, data: data.join("\n") });
  }

  return { frames, buffer: rest };
}

/**
 * Parse a frame's `data` payload as JSON. Returns `null` for an empty
 * payload, the OpenAI-style `[DONE]` terminator, or unparseable JSON —
 * the three cases every streaming consumer skips. (A literal JSON `null`
 * payload is indistinguishable from those; no platform stream emits one.)
 */
export function parseSseJsonData(data: string): unknown | null {
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
