// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Bounded, transport-safe truncation of arbitrary tool-result payloads before
 * they ride an {@link EventSink} (HTTP POST, JSONL stdout, a `run_logs` row).
 *
 * Used by any Runner that forwards a tool's result as an
 * `appstrate.progress` breadcrumb — the Pi runner surfaces tool results, and a
 * filesystem/HTTP read can produce MB-sized strings that have no business
 * sitting in a log row.
 */

/**
 * Hard ceiling (bytes) on a forwarded tool-result payload. Default sized for
 * the typical "tail of a stack trace + a few JSON blobs": large enough to keep
 * useful detail, small enough that 100 tool calls × 2 KB stays well under the
 * platform's `run_logs.data` 32 KB write boundary. Operator-tunable via
 * `TOOL_RESULT_BYTE_LIMIT` (forwarded into the agent container). Tool results
 * carrying the run's actual output are truncated at WRITE time — no read-side
 * knob recovers them — so deployments whose consumers read `getRunLogs` for
 * results raise this cap. Invalid / non-positive values fall back to the
 * compiled default.
 */
const DEFAULT_TOOL_RESULT_BYTE_LIMIT = 2048;

/** Resolve the effective tool-result cap: `TOOL_RESULT_BYTE_LIMIT` env override or default. */
export function toolResultByteLimit(): number {
  const raw = process.env.TOOL_RESULT_BYTE_LIMIT;
  if (raw === undefined || raw === "") return DEFAULT_TOOL_RESULT_BYTE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_TOOL_RESULT_BYTE_LIMIT;
  return parsed;
}

/**
 * Truncate an arbitrary tool result for safe transport on the event sink.
 * Strategy:
 *   - `string` payloads: byte-aware truncation with a single trailing
 *     "...(truncated, N bytes)" marker so the rendered output stays valid
 *     UTF-8 and self-documents the truncation.
 *   - everything else: serialise to JSON, apply the same cap; on overflow
 *     return a structured marker preserving the original byte size + a preview
 *     so sinks can render "[truncated …]" without re-serialising.
 *   - circular / non-serialisable: a `{ __truncated, reason: "non_serialisable" }`
 *     marker.
 */
export function truncateToolResult(
  result: unknown,
  limitBytes: number = toolResultByteLimit(),
): unknown {
  if (result === undefined || result === null) return result;
  if (typeof result === "string") return truncateString(result, limitBytes);
  // Booleans / numbers / bigint / symbols never trigger truncation.
  if (typeof result !== "object") return result;
  let serialised: string;
  try {
    serialised = JSON.stringify(result);
  } catch {
    return { __truncated: true, reason: "non_serialisable" };
  }
  if (serialised === undefined) return result;
  const byteLength = Buffer.byteLength(serialised, "utf8");
  if (byteLength <= limitBytes) return result;
  return {
    __truncated: true,
    reason: "size",
    bytes: byteLength,
    limit: limitBytes,
    preview: truncateString(serialised, Math.min(512, limitBytes)),
  };
}

function truncateString(s: string, limitBytes: number): string {
  const byteLength = Buffer.byteLength(s, "utf8");
  if (byteLength <= limitBytes) return s;
  // Walk back from the byte limit so the returned slice lands on a valid UTF-8
  // boundary (a leading byte, not a 10xxxxxx continuation byte).
  const buf = Buffer.from(s, "utf8");
  let cut = limitBytes;
  while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return `${buf.subarray(0, cut).toString("utf8")}…(truncated, ${byteLength} bytes)`;
}
