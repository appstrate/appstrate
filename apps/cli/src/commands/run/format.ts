// SPDX-License-Identifier: Apache-2.0

/**
 * Formatting helpers for tool-call events rendered by the human
 * console sink.
 *
 * Kept separate from `sink.ts` so the verbosity / truncation logic can
 * be unit-tested in isolation and stays at structural parity with the
 * web log viewer (`apps/web/src/components/log-utils.ts → formatToolArgs`).
 *
 * Two distinct concerns live here:
 *
 *   1. **Arg formatting** — what the LLM passed to the tool. Mirrors the
 *      web's `key: value, …` shape so the user sees the same call across
 *      surfaces. Compact mode truncates at 200 chars; verbose mode
 *      pretty-prints the full JSON.
 *
 *   2. **Result formatting** — what the tool returned. The bridge
 *      already truncates the wire payload to 2 KB
 *      (TOOL_RESULT_BYTE_LIMIT) and signals truncation via a
 *      `__truncated: true` marker; this layer adds a per-mode preview
 *      length on top of that hard cap so default output stays readable
 *      and `-v` reveals more.
 */

export type Verbosity = "quiet" | "normal" | "verbose";

/** Compact arg preview length (matches `apps/web/src/components/log-utils.ts`). */
export const ARGS_PREVIEW_CHARS = 200;
/** Default result preview length — first line, short, screen-friendly. */
export const RESULT_PREVIEW_CHARS = 100;
/**
 * Verbose result preview length. Lines up with the bridge's
 * TOOL_RESULT_BYTE_LIMIT so `-v` surfaces the full payload the bridge
 * was willing to forward — no information held back from the user when
 * they asked for it.
 */
export const RESULT_VERBOSE_CHARS = 2048;

/**
 * Format tool args for compact display. Mirrors the web log viewer:
 *   `key: value, key2: value2`
 * truncated at {@link ARGS_PREVIEW_CHARS} with a trailing ellipsis. Null /
 * undefined values are skipped — they carry no signal for the operator.
 */
export function formatToolArgsCompact(args: Record<string, unknown> | null | undefined): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const str = typeof value === "string" ? value : safeJSON(value);
    parts.push(`${key}: ${str}`);
  }
  const joined = parts.join(", ");
  return joined.length > ARGS_PREVIEW_CHARS ? joined.slice(0, ARGS_PREVIEW_CHARS) + "..." : joined;
}

/**
 * Format tool args for verbose display — pretty-printed JSON with
 * 2-space indent. Falls back to the compact form on circular refs so
 * the renderer never throws on a malformed payload from a
 * misbehaving tool.
 */
export function formatToolArgsVerbose(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return String(args);
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return formatToolArgsCompact(args as Record<string, unknown>);
  }
}

/**
 * Format a tool result for display. `verbose` switches between the
 * single-line preview and a multi-line JSON dump.
 *
 * The result has already been truncated by the bridge — this layer
 * never sees more than ~2 KB. We additionally cap to a smaller preview
 * in non-verbose mode so the screen stays usable; the truncation
 * marker stays visible either way.
 */
export function formatToolResult(result: unknown, verbosity: Exclude<Verbosity, "quiet">): string {
  const limit = verbosity === "verbose" ? RESULT_VERBOSE_CHARS : RESULT_PREVIEW_CHARS;
  if (result === undefined || result === null) return "";
  let text: string;
  if (typeof result === "string") {
    text = result;
  } else {
    text = safeJSON(result, verbosity === "verbose" ? 2 : 0);
  }
  // Newlines wreck single-line displays; in compact mode swap them for
  // a visible glyph so the user still sees there were multiple lines.
  if (verbosity !== "verbose") {
    text = text.replace(/\r?\n/g, " ↵ ");
  }
  if (text.length > limit) text = text.slice(0, limit) + "...";
  return text;
}

/**
 * Resolve verbosity from the user-supplied flags + environment. Order
 * of precedence: explicit flag wins over env var; default is `normal`.
 * `--quiet` and `--verbose` are mutually exclusive — caller validates.
 */
export function resolveVerbosity(opts: {
  verbose?: boolean;
  quiet?: boolean;
  envValue?: string | undefined;
}): Verbosity {
  if (opts.verbose) return "verbose";
  if (opts.quiet) return "quiet";
  const env = opts.envValue;
  if (env === "1" || env === "true") return "verbose";
  if (env === "quiet") return "quiet";
  return "normal";
}

function safeJSON(value: unknown, indent: number = 0): string {
  try {
    const out = JSON.stringify(value, null, indent || undefined);
    return out === undefined ? String(value) : out;
  } catch {
    return String(value);
  }
}
