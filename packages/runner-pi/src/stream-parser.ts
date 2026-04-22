// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Pi stdout → RunEvent adaptation.
 *
 * Pi agent containers emit one JSON line per event on stdout. The
 * runtime-pi entrypoint drives a {@link PiRunner} that already produces
 * canonical AFPS events, so the parser is a thin JSON-shape validator:
 *   - Well-formed RunEvent objects pass through verbatim.
 *   - Everything else (stray stderr, non-event JSON) is wrapped as a
 *     `[container]` progress breadcrumb so operators still see it.
 *
 * {@link processPiLogs} layers text-delta coalescing on top: short plain
 * progress chunks are buffered and flushed at markdown fences / size
 * thresholds, avoiding thousands of single-character events in the DB.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";

export function parsePiStreamLine(line: string, runId: string): RunEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;

    if (
      typeof obj.type === "string" &&
      typeof obj.timestamp === "number" &&
      typeof obj.runId === "string"
    ) {
      return obj as RunEvent;
    }

    return progressEvent(runId, `[container] ${trimmed}`);
  } catch {
    return progressEvent(runId, `[container] ${trimmed}`);
  }
}

export async function* processPiLogs(
  logs: AsyncIterable<string>,
  runId: string,
): AsyncGenerator<RunEvent> {
  let textBuffer = "";
  let inCodeBlock = false;

  const emitBuffer = (): RunEvent | null => {
    const text = textBuffer.trim();
    textBuffer = "";
    return text.length > 0 ? progressEvent(runId, text) : null;
  };

  for await (const line of logs) {
    const msg = parsePiStreamLine(line, runId);
    if (!msg) continue;

    const isPlainProgress =
      msg.type === "appstrate.progress" &&
      msg.message !== undefined &&
      msg.data === undefined &&
      msg.level === undefined;

    if (isPlainProgress) {
      textBuffer += String(msg.message ?? "");

      if (inCodeBlock) {
        const closeIdx = textBuffer.indexOf("```");
        if (closeIdx !== -1) {
          inCodeBlock = false;
          textBuffer = textBuffer.substring(closeIdx + 3);
        } else {
          textBuffer = "";
        }
        continue;
      }

      const fenceIdx = textBuffer.indexOf("```");
      if (fenceIdx !== -1) {
        const before = textBuffer.substring(0, fenceIdx);
        textBuffer = before;
        const flushed = emitBuffer();
        if (flushed) yield flushed;
        inCodeBlock = true;
        textBuffer = "";
        continue;
      }

      if (textBuffer.length >= 300 && !textBuffer.endsWith("`") && !textBuffer.endsWith("``")) {
        const flushed = emitBuffer();
        if (flushed) yield flushed;
      }
      continue;
    }

    const flushed = emitBuffer();
    if (flushed) yield flushed;

    yield msg;
  }

  const remaining = emitBuffer();
  if (remaining) yield remaining;
}

function progressEvent(
  runId: string,
  message: string,
  extra?: { data?: unknown; level?: string },
): RunEvent {
  const event: RunEvent = {
    type: "appstrate.progress",
    timestamp: Date.now(),
    runId,
    message,
  };
  if (extra?.data !== undefined) event.data = extra.data;
  if (extra?.level !== undefined) event.level = extra.level;
  return event;
}
