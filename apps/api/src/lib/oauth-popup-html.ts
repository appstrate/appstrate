// SPDX-License-Identifier: Apache-2.0

/**
 * Tiny HTML snippets returned by OAuth callback endpoints to close (or
 * surface an error in) the popup that initiated the flow. Used by the
 * integration OAuth flow (`routes/integrations.ts`) — keep one source so
 * a CSP/branding change touches a single file.
 */

import { escapeHtml } from "@appstrate/core/html";

/** Auto-closes the popup immediately on success. */
export function popupHtmlClose(): string {
  return `<html><body><script>window.close();</script></body></html>`;
}

/**
 * Renders `msg` (safely HTML-escaped) in red monospace and schedules
 * `window.close()` after `ttlMs` so the user has time to read the
 * message before the popup disappears.
 */
export function popupHtmlError(msg: string, ttlMs = 5000): string {
  return `<html><body><p style="color:red;font-family:monospace;">${escapeHtml(msg)}</p><script>setTimeout(()=>window.close(),${ttlMs});</script></body></html>`;
}
