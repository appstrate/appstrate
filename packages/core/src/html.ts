// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * HTML escaping helper — XSS-safe string interpolation for HTML contexts.
 *
 * Escapes the five characters that are unsafe to leave raw inside HTML text
 * or attribute values: `&`, `<`, `>`, `"`, and `'`. The single-quote escape
 * is required because attributes can be quoted with either `"` or `'`, and
 * omitting it leaves a latent XSS vector for `attr='${value}'` patterns.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a user-controlled string for safe HTML interpolation. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}
