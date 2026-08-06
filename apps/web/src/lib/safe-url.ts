// SPDX-License-Identifier: Apache-2.0

/**
 * Navigation-sink guard for URLs that do NOT originate in this codebase.
 *
 * AFPS manifests are author-controlled and importable from a ZIP or a public
 * GitHub URL, and fields such as `repository` / `setup_guide.steps[].url` are
 * validated server-side as `z.string().min(1)` — no scheme constraint. Putting
 * such a value straight into an `href` turns a manifest into script execution
 * on the platform origin, which is an authenticated cookie-session origin.
 * `target="_blank" rel="noopener noreferrer"` does not help: `rel` constrains
 * the opened context, never the scheme, and `javascript:` never opens a
 * context in the first place — it runs in the current document.
 *
 * The check is an allowlist over the *parsed* protocol, never a string match
 * on the raw value. `new URL()` is the same WHATWG parser the browser applies
 * before navigating, so it already collapses every obfuscation a blocklist
 * would miss — case (`JaVaScRiPt:`), embedded tab/newline/carriage return
 * (`java\tscript:`), and leading or trailing C0 controls and spaces are all
 * normalized away before we read `.protocol`. Anything the parser rejects
 * (empty string, malformed input, and every relative form including the
 * scheme-relative `//evil.com` that a naive `startsWith("http")` lets through)
 * throws here and is refused.
 *
 * Relative URLs are deliberately NOT allowed. These fields describe resources
 * outside the platform; a relative value would resolve against our own origin,
 * which is meaningless for a repository link and lets a publisher dress up a
 * platform URL as their own documentation.
 *
 * The value is rejected, never rewritten — a sanitized string is a guess about
 * intent, and a guess in a navigation sink is the bug this guards against.
 */

/** Schemes safe to place in a navigation sink for third-party-authored data. */
const SAFE_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Returns the normalized URL when `value` is safe to use as a link target,
 * `null` otherwise. Call sites must render plain text on `null` rather than
 * an anchor, so the value stays visible to whoever is auditing the package.
 *
 * The returned string is the parser's own normalization (`URL.href`) rather
 * than the raw input, so the href is exactly what was validated and no
 * parser differential can open between the two.
 */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
}
