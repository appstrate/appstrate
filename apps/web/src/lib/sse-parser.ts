// SPDX-License-Identifier: Apache-2.0

/** A parsed SSE frame: its `event:` name and concatenated `data:` payload. */
export interface SSEFrame {
  event: string;
  data: string;
}

/**
 * Pure SSE frame parser for the `fetch` + `ReadableStream` reader in
 * `use-global-run-sync.ts`. Given a freshly-decoded `chunk` and the
 * `buffer` left over from the previous read, it splits on the `\n\n`
 * frame separator, parses complete frames, and returns the new leftover
 * buffer (an incomplete trailing frame, if any).
 */
export function parseSSEFrames(
  chunk: string,
  buffer: string,
): { frames: SSEFrame[]; buffer: string } {
  const combined = buffer + chunk;
  const parts = combined.split("\n\n");
  const rest = parts.pop()!;

  const frames: SSEFrame[] = [];
  for (const part of parts) {
    let event = "";
    let data = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    frames.push({ event, data });
  }

  return { frames, buffer: rest };
}
