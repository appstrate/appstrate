// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import Mustache from "mustache";

/**
 * Render a Mustache template against a context view.
 *
 * AFPS bundles use logic-less Mustache as a safety boundary: templates
 * cannot execute arbitrary code, and the rendered output is produced from
 * a controlled projection of the {@link ExecutionContext} — the `view`
 * object built by {@link buildPromptView} (see
 * `AFPS_EXTENSION_ARCHITECTURE.md` §3.2 "pure template / impure context").
 *
 * Escaping is disabled: prompts are treated as plain-text / Markdown,
 * not HTML. `{{var}}` and `{{{var}}}` therefore behave identically.
 *
 * The view is stripped of functions (Mustache "lambdas") before
 * rendering — they would otherwise execute during interpolation and
 * break the logic-less invariant. Undefined and `Symbol` values are
 * removed for the same reason. Anything JSON-serializable passes
 * through unchanged.
 *
 * A missing variable renders as the empty string — consistent with the
 * Mustache spec, and intentional: absent data should yield an absent
 * section, never `"undefined"` in the prompt.
 *
 * @throws if `template` contains an unclosed section or other syntax error.
 */
export function renderTemplate(template: string, view: unknown): string {
  const sanitized = sanitizeView(view);
  const previousEscape = Mustache.escape;
  Mustache.escape = (text) => text;
  try {
    return Mustache.render(template, sanitized as Record<string, unknown>);
  } finally {
    Mustache.escape = previousEscape;
  }
}

/**
 * Strip anything non-data (functions, symbols, undefined) from a view
 * via a JSON round-trip. Preserves arrays, plain objects, strings,
 * numbers, booleans, and `null` — the full JSON subset.
 */
function sanitizeView(view: unknown): unknown {
  if (view === null || view === undefined) return {};
  try {
    return JSON.parse(JSON.stringify(view));
  } catch {
    return {};
  }
}

/**
 * Validate a template without rendering it. Returns `{ ok: true }` on
 * success or `{ ok: false, error }` on parse failure. Useful for bundle
 * validation at ingest time, before any runtime substitution occurs.
 */
export function validateTemplate(template: string): { ok: true } | { ok: false; error: string } {
  try {
    Mustache.parse(template);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
