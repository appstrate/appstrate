// SPDX-License-Identifier: Apache-2.0

/**
 * HTML returned by the integration OAuth callback (`routes/integrations.ts`).
 *
 * The page must work in two very different launch contexts from a single
 * response, because the same `auth_url` can be opened either way:
 *
 *  1. **Popup** — the dashboard "Connect" button (and the chat auth card)
 *     open the flow in a `window.open()` popup. Here we can `window.close()`.
 *  2. **Full tab** — the chat assistant may surface the raw `auth_url` as a
 *     link; the user opens it in the current tab. `window.close()` is a no-op
 *     on a tab the script didn't open, so a bare close left a blank page.
 *
 * In both cases we first *signal completion* so any waiting surface resumes
 * without the user copy-pasting anything back:
 *  - `postMessage` to `window.opener` (instant, same-browser popup case).
 *  - a `BroadcastChannel` publish (rattrape le cas plein-onglet: an already
 *    open chat tab in the same browser hears it even though it isn't the
 *    opener).
 * Then we try to close, and if we're still here (full tab) we render a
 * readable confirmation instead of a blank page.
 *
 * Keep one source so a CSP/branding change touches a single file.
 */

import { escapeHtml } from "@appstrate/core/html";
import { getEnv } from "@appstrate/env";

/**
 * Target origin for the `postMessage` to `window.opener`. Scoping the message
 * to the platform's own origin — instead of the wildcard `"*"` — stops any
 * unrelated page that happened to open `auth_url` from reading the `state` +
 * `packageId` the callback broadcasts. The opener is always the dashboard SPA
 * served from `APP_URL`, so its origin is the correct (and only) audience.
 */
function appOrigin(): string {
  return new URL(getEnv().APP_URL).origin;
}

/** Channel name shared with the chat auth card (`packages/module-chat`). */
export const INTEGRATION_BROADCAST_CHANNEL = "appstrate_integration";
/** postMessage / BroadcastChannel message type the chat card listens for. */
export const INTEGRATION_MESSAGE_TYPE = "appstrate:integration_connection";

export interface OAuthCallbackDetail {
  /** Signed state echoed by the provider — correlates the waiting card. */
  state?: string | undefined;
  /** `@scope/name` of the integration just connected. */
  packageId?: string | undefined;
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARA_SEPARATOR = String.fromCharCode(0x2029);

/**
 * JSON-encode a value for safe embedding inside an inline `<script>`: escape
 * `<` (so the payload can't break out of the script element) and the U+2028 /
 * U+2029 separators (valid in JSON strings but illegal in JS source).
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .split(LINE_SEPARATOR)
    .join("\\u2028")
    .split(PARA_SEPARATOR)
    .join("\\u2029");
}

function page(payload: Record<string, unknown>, body: string, closeDelayMs: number): string {
  const data = jsonForScript({ type: INTEGRATION_MESSAGE_TYPE, ...payload });
  const targetOrigin = JSON.stringify(appOrigin());
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Appstrate</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#0b0b0c;color:#e5e5e5}main{text-align:center;padding:2rem;max-width:28rem}.ok{color:#4ade80}.err{color:#f87171}p{line-height:1.5}</style></head><body><main>${body}</main><script>
(function(){
  var detail = ${data};
  try { if (window.opener) window.opener.postMessage(detail, ${targetOrigin}); } catch (e) {}
  try { var bc = new BroadcastChannel(${JSON.stringify(INTEGRATION_BROADCAST_CHANNEL)}); bc.postMessage(detail); bc.close(); } catch (e) {}
  setTimeout(function(){ try { window.close(); } catch (e) {} }, ${closeDelayMs});
})();
</script></body></html>`;
}

/** Success: signal the opener/channel, then close (popup) or confirm (tab). */
export function popupHtmlClose(detail: OAuthCallbackDetail = {}): string {
  return page(
    { ok: true, state: detail.state, packageId: detail.packageId },
    `<p class="ok">&#10003; Intégration connectée.</p><p>Vous pouvez fermer cet onglet et revenir à la conversation.</p>`,
    300,
  );
}

/**
 * Failure: render `msg` (HTML-escaped) and still signal the waiting surface so
 * it can stop showing a pending state, then schedule a close after `ttlMs`.
 */
export function popupHtmlError(
  msg: string,
  detail: OAuthCallbackDetail = {},
  ttlMs = 5000,
): string {
  return page(
    { ok: false, state: detail.state, packageId: detail.packageId, error: msg },
    `<p class="err">${escapeHtml(msg)}</p><p>Vous pouvez fermer cet onglet et réessayer depuis la conversation.</p>`,
    ttlMs,
  );
}
