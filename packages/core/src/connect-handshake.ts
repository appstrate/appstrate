// SPDX-License-Identifier: Apache-2.0

/**
 * The integration-connect completion handshake: one contract for the four
 * surfaces that speak it.
 *
 * A connect flow ends on a page the platform serves — the OAuth callback HTML
 * (`apps/api/src/lib/oauth-popup-html.ts`) or the hosted credential form
 * (`apps/web/src/pages/hosted-connect.tsx`) — while the surface that started it
 * waits elsewhere: the dashboard connect popup
 * (`components/integration-connect/use-integration-oauth-popup.ts`) or the
 * in-chat connect card (`packages/module-chat/src/ui/oauth-connect-card.tsx`).
 * The finishing page announces completion twice, because the two launch
 * contexts need different carriers: a `postMessage` to `window.opener` (the
 * popup case) and a `BroadcastChannel` publish (the full-tab case, where there
 * is no opener but a sibling tab is still listening).
 *
 * The channel name, the message type and the payload used to be private
 * constants in three packages held together by "must match" comments, and the
 * two senders had already drifted on the one thing that matters: one scoped its
 * `postMessage` to the platform origin, the other posted to `"*"`. Everything
 * the four surfaces must agree on now lives here, so agreement is a compile
 * dependency rather than a comment.
 */

/** `BroadcastChannel` name every connect surface publishes and subscribes on. */
export const INTEGRATION_CONNECT_CHANNEL = "appstrate_integration";

/** `type` discriminator carried by every completion message. */
export const INTEGRATION_CONNECT_MESSAGE_TYPE = "appstrate:integration_connection";

/**
 * The completion payload.
 *
 * Every field is optional because a listener reads this off the wire: the
 * shape is what a sender promises, never what a receiver may assume. Senders
 * build it with {@link buildIntegrationConnectCompletion}, which always sets
 * `type` and `ok`.
 */
export interface IntegrationConnectCompletion {
  /** Always {@link INTEGRATION_CONNECT_MESSAGE_TYPE} when we minted it. */
  type?: string;
  /** `false` on failure, so a waiting surface stops its spinner either way. */
  ok?: boolean;
  /** Signed OAuth state echoed by the provider — correlates the waiting card. */
  state?: string | undefined;
  /** `@scope/name` of the integration the flow was for. */
  packageId?: string | undefined;
  /** User-facing failure reason; present only when `ok` is `false`. */
  error?: string | undefined;
}

/** Mint a completion payload with the shared discriminator applied. */
export function buildIntegrationConnectCompletion(detail: {
  ok: boolean;
  state?: string | undefined;
  packageId?: string | undefined;
  error?: string | undefined;
}): IntegrationConnectCompletion {
  return { type: INTEGRATION_CONNECT_MESSAGE_TYPE, ...detail };
}

/**
 * The single audience of a completion `postMessage`: the platform's own origin.
 *
 * Both senders are pages the platform serves and both listeners are platform
 * code running on that same origin, so the message never legitimately crosses
 * an origin boundary. Scoping the send keeps an unrelated page that happened to
 * open the connect URL from reading the `state` + `packageId`; the receive-side
 * counterpart is {@link isIntegrationConnectMessage}.
 *
 * `postMessage` compares only the origin of whatever URL it is handed, so a
 * caller passing `APP_URL` with a path or a trailing slash already behaves
 * correctly — normalising here makes the sent and the validated string the
 * same one, which is what the two sides kept getting wrong.
 */
export function integrationConnectOrigin(appUrl: string): string {
  return new URL(appUrl).origin;
}

/** Whether `data` is shaped like a completion this handshake minted. */
export function isIntegrationConnectCompletion(
  data: unknown,
): data is IntegrationConnectCompletion {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === INTEGRATION_CONNECT_MESSAGE_TYPE
  );
}

/**
 * What `URL.origin` serialises to for a scheme that carries no tuple origin
 * (`about:`, `data:`, `file:`, `blob:null`) and what every sandboxed document
 * reports as its `postMessage` origin. It identifies nobody, so it is never a
 * valid party to this handshake on either side.
 */
const OPAQUE_ORIGIN = "null";

/**
 * Whether a `message` event may be acted on as a connect completion.
 *
 * The origin is checked before the payload: a listener that reads `event.data`
 * without validating `event.origin` has no authentication at all — any page
 * able to reach the window can forge a completion and drive the waiting
 * surface. `selfUrl` is the receiving page's own origin
 * (`window.location.origin`), since that is the only origin a completion is
 * ever sent from.
 */
export function isIntegrationConnectMessage<T extends { origin: string; data: unknown }>(
  event: T,
  selfUrl: string,
): event is T & { data: IntegrationConnectCompletion } {
  let self: string;
  try {
    self = integrationConnectOrigin(selfUrl);
  } catch {
    // An unparseable `selfUrl` (the bare literal `"null"`, an empty string).
    // Trust nothing rather than throw out of a `message` listener.
    return false;
  }
  // A URL can PARSE and still serialise to the opaque origin `"null"`:
  // `about:blank`, `data:`, `file:` and `blob:null` all do. Every sandboxed
  // sender also reports `"null"`, so an equality test would make two unrelated
  // opaque origins compare equal and accept a forged completion. An opaque
  // origin identifies nobody — it can never be the platform origin a
  // completion is sent from, so it is refused outright rather than matched.
  if (self === OPAQUE_ORIGIN) return false;
  return (
    event.origin !== OPAQUE_ORIGIN &&
    event.origin === self &&
    isIntegrationConnectCompletion(event.data)
  );
}
