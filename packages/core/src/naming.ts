// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import {
  allocateMcpToolNamespace,
  MCP_TOOL_NAME_MAX_LENGTH,
  normaliseMcpToolBody,
  normaliseMcpToolNamespace,
} from "@appstrate/afps-shared/mcp-naming";

export { allocateMcpToolNamespace, normaliseMcpToolBody, normaliseMcpToolNamespace };

/** Regex pattern string for a valid slug: lowercase alphanumeric with optional hyphens. */
export const SLUG_PATTERN = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
/** Compiled regex for validating a single slug string. */
export const SLUG_REGEX = new RegExp(`^${SLUG_PATTERN}$`);

/**
 * Canonical snake_case identifier pattern: a lowercase letter followed by
 * lowercase alphanumerics and underscores. Single source of truth for every
 * `^[a-z][a-z0-9_]*$` check in the codebase (previously re-declared verbatim
 * in `apps/web/src/lib/strings.ts` and inline Zod in the API).
 *
 * Two distinct concepts share this exact alphabet:
 *  - **Credential / AFPS auth keys** — the sidecar substitution contract
 *    (`\w+`, hyphens disallowed); consumed by the web credentials editor and
 *    the API's system-integration `auth_key` gate (AFPS §7.2).
 *  - **MCP tool-name inner tokens** — each half of a `{ns}__{tool}` name
 *    (see {@link TOOL_NAME_INNER_PATTERN}, which aliases this).
 */
export const CREDENTIAL_KEY_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Ensure a scope string is prefixed with `@`.
 * @param scope - Scope string, with or without leading `@`
 * @returns The scope prefixed with `@`
 * @throws Error if scope is empty
 */
export function normalizeScope(scope: string): string {
  if (!scope) throw new Error("Scope cannot be empty");
  return scope.startsWith("@") ? scope : `@${scope}`;
}

/**
 * Remove the leading `@` from a scope string.
 * @param scope - Scope string, with or without leading `@`
 * @returns The scope without the `@` prefix
 */
export function stripScope(scope: string): string {
  return scope.startsWith("@") ? scope.slice(1) : scope;
}

/** Parse "@scope/name" into { scope, name } or null if invalid.
 *  Both scope and name must be valid slugs (lowercase alphanumeric + hyphens). */
const SCOPED_NAME_REGEX = new RegExp(`^@(${SLUG_PATTERN})\\/(${SLUG_PATTERN})$`);

export function parseScopedName(scopedName: string): { scope: string; name: string } | null {
  const match = scopedName.match(SCOPED_NAME_REGEX);
  if (!match) return null;
  return { scope: match[1]!, name: match[3]! };
}

/** Single source of truth for package ownership. */
export function isOwnedByOrg(packageId: string, orgSlug: string): boolean {
  if (!orgSlug) return false;
  const parsed = parseScopedName(packageId);
  if (!parsed) return false;
  return parsed.scope === orgSlug;
}

/** Build a packageId from separated scope + name. */
export function buildPackageId(scope: string, name: string): string {
  const s = stripScope(scope);
  return `@${s}/${name}`;
}

/**
 * Encode a packageId ("@scope/name") into a URL path segment, keeping the
 * `@` and `/` separators literal so it matches route shapes such as:
 *   - `/:scope{(?:@|%40)...}/:name`      (single top-level package)
 *   - `/:packageId{@[^/]+/[^/]+}`        (routes that reference ≥2 packages)
 *
 * Naive `encodeURIComponent(packageId)` percent-encodes `/`→%2F, so the
 * scope/name split is lost. Use this canonical encoder instead of hand-rolling
 * — it is the one contract every consumer (frontend, SDK, github-action, MCP)
 * should import rather than re-discovering the footgun.
 *
 * Each segment is `encodeURIComponent`-encoded individually (defensive even
 * if `SLUG_PATTERN` ever loosens); the `@`/`/` separators stay literal.
 *
 * @throws Error if packageId is not a valid "@scope/name".
 */
export function encodePackageIdPath(packageId: string): string {
  const parsed = parseScopedName(packageId);
  if (!parsed) throw new Error(`Invalid packageId: ${packageId}`);
  return `@${encodeURIComponent(parsed.scope)}/${encodeURIComponent(parsed.name)}`;
}

/**
 * Convert an arbitrary human string into a URL-safe slug.
 * Lower-cases, strips diacritics, collapses non-[a-z0-9] runs into `-`
 * and trims leading/trailing dashes. Optional `maxLen` caps the result
 * (caller-side truncation of names like org slugs).
 *
 * Not the same as `SLUG_REGEX` — this accepts any input and produces a
 * valid slug; `SLUG_REGEX` validates that an already-formed string is
 * one. Callers that need validation should compose: `toSlug(x)` then
 * `SLUG_REGEX.test(result)`.
 */
export function toSlug(value: string, maxLen?: number): string {
  const out = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return maxLen && maxLen > 0 ? out.slice(0, maxLen) : out;
}

// ---------------------------------------------------------------------------
// Filenames (documents / uploads)
// ---------------------------------------------------------------------------

/**
 * Ceiling on a stored filename. One constant so every producer and consumer of
 * a document/upload `name` truncates at the same point.
 */
export const MAX_FILENAME_LEN = 255;

/**
 * Strip path separators + control characters from a caller-supplied filename.
 *
 * Defense in depth only: the actual path-traversal block lives in the storage
 * layer (`makeKey()` rejects any raw bucket/path containing `..` or `\0` before
 * touching the filesystem). This helper keeps the stored filename
 * human-readable and prevents a `..` segment from surviving into the final
 * on-disk path even if the storage check ever regressed.
 *
 * Control chars (`\x00-\x1f`, `\x7f`) are collapsed too: CR/LF in a name would
 * otherwise survive into a stored filename and, on the download path, into a
 * `Content-Disposition` header (a response-splitting / header-injection vector
 * the presign path's quote-stripping alone does not cover).
 *
 * Lives in core (not in `apps/api`) because BOTH ends of the run-to-platform
 * document channel must apply the exact same rule: the API sanitizes the
 * incoming `X-Document-Name` before it becomes `documents.name`, and therefore
 * part of the `(run_id, sha256, name)` dedup identity, while the agent
 * container has to PREDICT that stored name to build a matching dedup key. When
 * the rule was only reachable from the server, the two keys silently diverged
 * on any name carrying a separator, a control char, `..`, or exceeding
 * {@link MAX_FILENAME_LEN}, and an already-stored file was re-streamed in full.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\\x00-\x1f\x7f]/g, "_")
    .replace(/\.\.+/g, ".")
    .trim();
  if (!cleaned) return "file";
  return cleaned.slice(0, MAX_FILENAME_LEN);
}

/**
 * Ceiling on the ENCODED header value accepted by
 * {@link decodeFilenameHeader}. A {@link MAX_FILENAME_LEN}-char name made of
 * 3-byte code points percent-encodes to 255 * 3 * 3 = 2295 chars; 4096 leaves
 * headroom for 4-byte code points while keeping the decode bounded.
 */
export const MAX_ENCODED_FILENAME_HEADER_LEN = 4096;

/**
 * The exact alphabet `encodeURIComponent` can emit: the unreserved characters
 * plus the `%` that introduces an escape. Anything else (a raw non-ASCII byte,
 * a space, a `/`) proves the sender did NOT encode, and is rejected rather than
 * guessed at.
 */
const ENCODED_FILENAME_RE = /^[A-Za-z0-9\-_.!~*'()%]+$/;

/**
 * Encode a filename for transport in an HTTP header value.
 *
 * HTTP field values are ISO-8859-1 by spec, so a non-ASCII name sent raw is
 * either REFUSED outright by the sender (Bun's `Headers` throws
 * `has invalid value` on a CJK filename, and inside a `fetch` try/catch that
 * throw is indistinguishable from a retryable network fault) or silently
 * mojibaked (a French accented name written UTF-8 and read back Latin-1 becomes
 * the value that is then stored, displayed, and served in
 * `Content-Disposition`).
 *
 * Percent-encoding (`encodeURIComponent`) is the chosen wire form: its output
 * always sits inside {@link ENCODED_FILENAME_RE}, so it is a valid field value
 * for ANY Unicode name; the inverse is a single standard call; it round-trips
 * byte-for-byte; and a plain ASCII name comes out unchanged, so logs and
 * captured requests stay readable. RFC 5987's `filename*=UTF-8''<pct-encoded>`
 * carries the same payload but adds an ext-value grammar that only pays off on
 * `Content-Disposition`, where a browser is the peer; here both ends are ours.
 */
export function encodeFilenameHeader(name: string): string {
  return encodeURIComponent(name);
}

/**
 * Inverse of {@link encodeFilenameHeader}. Returns `null` (never a guess) for
 * an over-long value, a value outside the encoder's alphabet (i.e. a raw,
 * un-encoded name), or a malformed / invalid-UTF-8 escape sequence. Callers
 * turn that `null` into a typed 400.
 */
export function decodeFilenameHeader(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_ENCODED_FILENAME_HEADER_LEN) return null;
  if (!ENCODED_FILENAME_RE.test(raw)) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed escape (`%zz`, a truncated `%E4%`) or invalid UTF-8 (`%FF`).
    return null;
  }
}

/**
 * Canonical MIME → filename-extension table for the text-shaped and common
 * document formats the platform names files after. Values carry no leading dot.
 *
 * ONE table because the same question is asked on both sides of the run
 * boundary: the platform names an unnamed inline `data:` input
 * (`services/input-parser.ts`), and the runtime names a spilled MCP resource
 * inside the container (`runner-pi/.../resource-spill.ts`). They used to hold
 * separate lists that disagreed — the platform knew YAML but not `text/xml` or
 * PDF, the runtime the reverse — so the same payload could land as `report.yaml`
 * on one side and `report.bin` on the other.
 */
const MIME_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["text/plain", "txt"],
  ["text/markdown", "md"],
  ["text/csv", "csv"],
  ["text/html", "html"],
  ["text/xml", "xml"],
  ["application/json", "json"],
  ["application/xml", "xml"],
  ["application/x-yaml", "yaml"],
  ["application/yaml", "yaml"],
  ["application/pdf", "pdf"],
]);

/**
 * Best-effort filename extension for a MIME type, or null when nothing sensible
 * can be derived. Tolerates a parameterized value (`text/csv; charset=utf-8`).
 *
 * Beyond the explicit table, the RFC 6839 structured suffixes (`+json`, `+xml`,
 * `+yaml`) and the `text/*` family resolve to their base format — the same
 * suffix convention `mime-policy.ts` uses to decide a MIME is text-shaped.
 *
 * Callers decide what "unknown" means for them: the input parser falls back to
 * the MIME subtype (then `bin`) because a file on disk must have SOME name,
 * while the resource spiller simply leaves the basename extensionless.
 *
 * The one-line parameter strip below is deliberately inlined rather than taken
 * from `apps/api/src/services/mime-policy.ts` (`normalizeMime`): core sits BELOW
 * the API in the dependency graph — and below the container runtime, the other
 * consumer — so it cannot import the policy module.
 */
export function extensionForMime(mime: string | undefined): string | null {
  if (!mime) return null;
  const base = mime.split(";", 1)[0]!.trim().toLowerCase();
  const known = MIME_EXTENSIONS.get(base);
  if (known) return known;
  if (base.endsWith("+json")) return "json";
  if (base.endsWith("+xml")) return "xml";
  if (base.endsWith("+yaml")) return "yaml";
  if (base.startsWith("text/")) return "txt";
  return null;
}

/**
 * Build the `Content-Disposition: attachment` header value for a stored file.
 *
 * RFC 5987 / RFC 6266 two-part form, emitted for EVERY download branch:
 *
 *  - `filename="…"` — the ASCII fallback for legacy clients. Control chars
 *    (incl. CR/LF), quotes, backslashes and every non-ASCII code point collapse
 *    to `_`, so the value can neither split the response nor break the client's
 *    quoted-string parse.
 *  - `filename*=UTF-8''…` — the real, possibly non-ASCII name, percent-encoded.
 *    Compliant clients prefer it, so an accented or CJK name downloads intact.
 *
 * Lives here — next to {@link sanitizeFilename}, which is what keeps a CR/LF out
 * of the stored name in the first place — because the platform serves a document
 * through TWO code paths: the proxy stream sets this header itself, and the S3
 * backend binds it into the presigned GET as `response-content-disposition`.
 * When each path built its own value, the presigned branch degraded a non-ASCII
 * name to a quote-stripped, mojibake-prone `filename="…"` while the proxy branch
 * returned it correctly. One builder, one behaviour.
 */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * MCP tool name validation.
 *
 * Format: `{namespace_snake}__{tool_snake}` — two snake_case tokens
 * joined by a double underscore. Hard length ceiling 56 chars leaves
 * headroom under the 64-char OpenAI/Anthropic limit for downstream
 * host re-prefixing (e.g. some CLI hosts add their own
 * `mcp__plugin_<plugin>_<server>__<tool>` super-prefix).
 */
export const TOOL_NAME_MAX_LEN = MCP_TOOL_NAME_MAX_LENGTH;
/**
 * Inner-token snake_case pattern shared by both halves of the namespaced MCP
 * tool name. Exposed so consumers that validate a *single* tool name (e.g.
 * `agentManifestSchema`'s `integrations[id].tools[]` — the agent
 * picks bare tool names, not pre-namespaced ones) match the same alphabet as
 * `TOOL_NAME_PATTERN`. Forbids a leading underscore so validation.ts and
 * naming.ts agree: validation.ts used to accept `_internal` while
 * naming.ts rejected `_internal__foo`, leaving a manifest-vs-runtime drift.
 *
 * Same shape as {@link CREDENTIAL_KEY_RE} — aliased so the pattern lives once.
 */
export const TOOL_NAME_INNER_PATTERN = CREDENTIAL_KEY_RE;
// The namespace token derives from a package id whose scope may start with a
// digit (`SLUG_PATTERN` and the AFPS name pattern both allow `@1password/…`),
// so it admits a leading digit. The tool token keeps the stricter
// letter-leading alphabet of {@link TOOL_NAME_INNER_PATTERN}.
const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9_]*__[a-z][a-z0-9_]*$/;

export function isValidToolName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > TOOL_NAME_MAX_LEN) return false;
  return TOOL_NAME_PATTERN.test(name);
}

/**
 * Normalise a raw tool name into the canonical snake_case `__`-joined
 * form. Returns the input unchanged when it's already valid.
 *
 * Mapping rules:
 * - Hyphens \u2192 underscores.
 * - Single-underscore separator \u2192 double-underscore boundary (only when
 *   no `__` is already present).
 * - Mixed-case \u2192 lower-case.
 */
export function normalizeToolName(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  let out = raw.toLowerCase();
  out = out.replace(/[-]+/g, "_");
  // If there's no `__` boundary yet, promote the first single underscore.
  if (!out.includes("__")) {
    out = out.replace(/_/, "__");
  }
  return out.slice(0, TOOL_NAME_MAX_LEN);
}
