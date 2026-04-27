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
 * MCP `CallToolResult` envelope — `{ content: [{type:"text",text:"..."}, ...] }`.
 * Every tool registered through Pi or the sidecar's MCP layer returns this
 * shape, so 95% of `tool_execution_end` results in a real run carry it.
 * Rendering the envelope verbatim leaks `{"content":[{"type":"text","text":"...`
 * into the user's screen for every single tool call.
 *
 * Returns the concatenated text from every `text` block when the input
 * matches the MCP shape; `null` otherwise (caller falls back to JSON).
 */
export function unwrapMcpContent(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: unknown }).type;
    const text = (block as { text?: unknown }).text;
    if (type === "text" && typeof text === "string") texts.push(text);
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Detect the bridge's truncation marker — emitted by
 * `truncateToolResult` in `@appstrate/runner-pi` when a tool result
 * exceeds the wire-transport ceiling. The marker is a structured
 * payload (`{ __truncated: true, bytes, limit, preview, reason }`)
 * intentionally serialisable so platform/web consumers can render it
 * uniformly.
 */
interface TruncationMarker {
  __truncated: true;
  bytes: number;
  limit: number;
  preview?: string;
  reason?: string;
}

export function isTruncationMarker(v: unknown): v is TruncationMarker {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return m.__truncated === true && typeof m.bytes === "number" && typeof m.limit === "number";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Best-effort MCP-text extractor for truncated JSON previews.
 *
 * The bridge serialises the tool result *then* truncates the byte
 * stream, so a real-world large MCP envelope arrives here as an
 * invalid JSON fragment like:
 *
 *   `{"content":[{"type":"text","text":"---\\nname: agent...`
 *
 * `JSON.parse` rightfully rejects that. We pattern-match the MCP
 * envelope prefix, capture the partial JSON-string body (respecting
 * escape sequences so we don't truncate mid-`\u`), and decode it as a
 * standalone JSON string (`JSON.parse('"<captured>"')`). When the
 * decoded suffix is a stray escape we couldn't close, we fall back to
 * the raw captured bytes — still better than leaking the envelope.
 *
 * Returns `null` when the preview doesn't look like an MCP envelope.
 */
function extractMcpTextFromTruncatedJson(preview: string): string | null {
  const m = preview.match(
    /^\s*\{\s*"content"\s*:\s*\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\[\s\S])*)/,
  );
  if (!m || m[1] === undefined) return null;
  const captured = m[1];
  try {
    return JSON.parse(`"${captured}"`) as string;
  } catch {
    // Trailing dangling backslash from a chopped escape sequence —
    // drop it and retry, otherwise return raw captured bytes.
    const trimmed = captured.replace(/\\+$/, "");
    try {
      return JSON.parse(`"${trimmed}"`) as string;
    } catch {
      return trimmed;
    }
  }
}

/**
 * Render a truncation marker as a human-readable preview. Tries to
 * unwrap a JSON-encoded MCP envelope inside `preview` (the bridge
 * stringifies the original payload before truncating, so a tool
 * returning `{content:[{type:"text",text:"..."}]}` lands here as a
 * string `'{"content":[{"type":"text","text":"..."}]}'`).
 *
 * Two unwrapping paths, tried in order:
 *   1. `JSON.parse` succeeds → standard `unwrapMcpContent` walk.
 *   2. `JSON.parse` fails (truncated mid-string) → regex-based
 *      `extractMcpTextFromTruncatedJson` rescue.
 *
 * Both paths fall back to the raw preview if no MCP shape is detected.
 */
function formatTruncationMarker(m: TruncationMarker): string {
  const sizeBlurb = `(truncated ${formatBytes(m.bytes)} > ${formatBytes(m.limit)})`;
  const preview = m.preview ?? "";
  if (!preview) return sizeBlurb;
  let body = preview;
  try {
    const parsed: unknown = JSON.parse(preview);
    const unwrapped = unwrapMcpContent(parsed);
    if (unwrapped) body = unwrapped;
    else if (typeof parsed === "string") body = parsed;
  } catch {
    // Preview is invalid JSON — most likely truncated mid-string. Try
    // the regex rescue before giving up and rendering raw.
    const rescued = extractMcpTextFromTruncatedJson(preview);
    if (rescued !== null) body = rescued;
  }
  return `${sizeBlurb} ${body}`;
}

/**
 * Format a tool result for display. `verbose` switches between the
 * single-line preview and a multi-line JSON dump.
 *
 * Three rendering paths, tried in order:
 *   1. Bridge truncation marker → `(truncated 12.0 KB > 2 KB) <preview>`
 *      with the preview itself unwrapped if it carries an MCP envelope.
 *   2. MCP `CallToolResult` envelope → just the joined `text` blocks,
 *      no JSON framing leaked to the user.
 *   3. Anything else → JSON-stringify (compact in normal, pretty in
 *      verbose) so structured payloads (numbers, arrays of objects)
 *      stay legible.
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
  if (isTruncationMarker(result)) {
    text = formatTruncationMarker(result);
  } else if (typeof result === "string") {
    text = result;
  } else {
    const unwrapped = unwrapMcpContent(result);
    if (unwrapped !== null) {
      text = unwrapped;
    } else {
      text = safeJSON(result, verbosity === "verbose" ? 2 : 0);
    }
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
