// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Parser for the AFPS Runtime Event Protocol stdout stream.
 *
 * Every AFPS-compliant agent emits one JSON object per line on stdout.
 * This parser:
 *
 * - Extracts the five canonical AFPS events (see §5 of the architecture doc)
 * - Normalises the shape to match {@link AfpsEvent}
 * - Returns `null` for unparseable lines, non-AFPS events, or malformed
 *   shapes
 *
 * Non-AFPS events emitted by the underlying agent SDK (e.g. Pi SDK's
 * `text_delta`, `tool_start`, `usage`) are **not** AFPS canonical events
 * and are intentionally dropped here. They belong to the session
 * backend's internal protocol and, if surfaced, travel through a
 * separate telemetry channel.
 */

import { afpsEventSchema, type AfpsEvent } from "../types/afps-event.ts";

/**
 * Parse a single stdout line into an {@link AfpsEvent}, or `null` if the
 * line is not a canonical AFPS event. Never throws.
 */
export function parseAfpsEventLine(line: string): AfpsEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof obj !== "object" || obj === null) return null;
  const candidate = obj as { type?: unknown };
  if (typeof candidate.type !== "string") return null;

  const result = afpsEventSchema.safeParse(obj);
  return result.success ? result.data : null;
}
