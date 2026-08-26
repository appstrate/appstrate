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
 * `postMessage` to the platform origin, the other posted to `"*"`.
 *
 * What the four surfaces must agree on lives here: the wire names, the payload,
 * the origin policy for both directions ({@link integrationConnectOrigin},
 * {@link isIntegrationConnectMessage}) AND the correlation rule that decides
 * which waiting surface a given completion is for
 * ({@link completionMatches}, {@link acceptsCompletionMessage}). The
 * correlation was the half left behind the first time: it lived in the chat
 * module, so the dashboard popup could not import it and re-implemented the
 * gate without any correlation at all. A rule that only one of four surfaces
 * can reach is not centralised.
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
  // Refusing the RECEIVER's opaque origin is the whole guard: with `self` known
  // not to be `"null"`, the `event.origin === self` below cannot admit a `"null"`
  // sender either. A second `event.origin !== OPAQUE_ORIGIN` clause used to sit
  // here and could never discriminate — no test could detect its removal, which
  // is the tell.
  if (self === OPAQUE_ORIGIN) return false;
  return event.origin === self && isIntegrationConnectCompletion(event.data);
}

/**
 * Whether a completion is addressed to the surface identified by
 * `{ state, packageId }`.
 *
 * CORRELATION IS PART OF THE HANDSHAKE, not a chat-module detail. Both carriers
 * fan out: a `BroadcastChannel` publish reaches every listener on the origin and
 * a `postMessage` reaches every listener on the receiving window, so *which*
 * completion a waiting surface just saw is a question every surface has to ask,
 * and it has to get the same answer. It lived in `module-chat` for a while, out
 * of reach of the SPA's connect popup, which therefore re-implemented the gate
 * as "is it a completion and is `ok` true" — with the `packageId` it was waiting
 * on sitting three lines up, unused.
 *
 * A completion is accepted only when it is POSITIVELY addressed to the target.
 * The rule is one sentence: an identifier BOTH sides carry must agree, at least
 * one identifier must be SHARED, and a completion that identifies nothing at all
 * is for everyone. The two identifiers, and why neither alone covers every flow:
 *
 *  - `state` — the OAuth state is a per-flow nonce, so an equal pair on both
 *    sides identifies THIS flow and nothing else. The hosted-connect offer
 *    (`connect_url`) carries NO state (its OAuth state is minted later, at
 *    /connect/start click time), so surfaces from that flow cannot rely on it.
 *  - `packageId` — the package-level filter, mirroring the SSE
 *    `connection_update` backstop so all three completion signals share the same
 *    semantics. Without it, one Gmail connect flipped an unrelated card
 *    "connected" and double-resumed the conversation (forked thread). The OAuth
 *    callback's early failures (`popupHtmlError(msg, { state })` — the provider
 *    refused, `code` missing, the token exchange threw) carry no packageId,
 *    because the package is only known once the signed state is decoded.
 *
 * SHARED is the load-bearing word, and it is what a chain of `if`s kept getting
 * wrong. An identifier only ONE side carries neither addresses nor contradicts:
 * it must not decide, in either direction.
 *
 *  - It must not ACCEPT. A completion carrying only a state names a specific
 *    flow, so it is emphatically not context-less — yet a predicate that reached
 *    its permissive tail whenever `detail.packageId` was absent handed every
 *    such completion to every waiting surface. A Gmail OAuth failure drove an
 *    unrelated ClickUp card into its error state, and the target that identifies
 *    NOTHING accepted it too, which is the opposite of failing closed.
 *  - It must not REJECT. The same early failures must still reach the card that
 *    minted that state, even though that card also knows a `packageId` the
 *    completion never names.
 *
 * A disagreement on either identifier is fatal on its own, which is why this is
 * an AND and not a first-match chain. A matching state beside a mismatched
 * packageId is a contradiction, not a stronger match: the completion's
 * `packageId` is derived from the very state it echoes (`result.packageId`, read
 * out of the signed state), so a genuine pair can never disagree. Letting the
 * state override the mismatch is a widening no flow needs, and it resumes a card
 * on another integration's completion — the exact failure `packageId` was added
 * to prevent.
 *
 * `target.packageId` is optional in the type and a card really can mount without
 * one (`oauth-connect-card.tsx` reads it out of the model's tool args). A
 * surface that shares NO identifier with a completion cannot tell that
 * completion apart from any other, so it fails CLOSED.
 *
 * The one exception is the case the permissiveness was written for: completions
 * that identify nothing at all (context-less error pages such as "Missing
 * connect token", emitted by /connect/start before the flow ever resolved a
 * package OR a state) stay accepted by anyone. They only surface an error, never
 * an append.
 *
 * The cost of that closure, deliberately accepted: a surface holding only a
 * `packageId` (the hosted-connect offer) no longer mirrors the OAuth callback's
 * early failures, because those name a state it was never told and no package.
 * It keeps waiting while the callback page itself shows the user the error. The
 * fix for that is to widen the SENDER — give those paths their `packageId` — not
 * to reopen a predicate that would hand the same message to every other card.
 */
export function completionMatches(
  detail: unknown,
  target: { state?: string; packageId?: string },
): detail is IntegrationConnectCompletion {
  if (!isIntegrationConnectCompletion(detail)) return false;
  // An identifier is SHARED only when both sides carry it — the only condition
  // under which comparing it means anything.
  const stateShared = Boolean(target.state && detail.state);
  const packageShared = Boolean(target.packageId && detail.packageId);
  // Either disagreement settles it: a different flow, or a different
  // integration. Both are checked; neither short-circuits the other.
  if (stateShared && detail.state !== target.state) return false;
  if (packageShared && detail.packageId !== target.packageId) return false;
  // Something matched and nothing contradicted: positively addressed here.
  if (stateShared || packageShared) return true;
  // Nothing shared, so this completion is ours only if it is everyone's: the
  // context-less error pages, which name neither a flow nor a package.
  return !detail.state && !detail.packageId;
}

/**
 * Whether a `message` event may be acted on as a completion for
 * `{ state, packageId }` — the origin check and the correlation, in the order
 * that matters.
 *
 * The origin comes first: a listener that reads `event.data` without validating
 * `event.origin` has no authentication at all. The HTML Living Standard's
 * cross-document messaging section is explicit that a listener must check it. An accepted forgery drives the waiting surface into its
 * "connected" state — appending a resume turn the user never earned, telling the
 * model an integration is usable when it is not. Every completion is sent by a
 * page the platform serves, so `selfOrigin` (`window.location.origin`) is the
 * only acceptable sender.
 *
 * `BroadcastChannel` deliveries are same-origin by spec and have no origin to
 * check, so those listeners call {@link completionMatches} directly. That is the
 * only difference between the two carriers — the correlation is identical.
 */
export function acceptsCompletionMessage(
  event: { origin: string; data: unknown },
  selfOrigin: string,
  target: { state?: string; packageId?: string },
): boolean {
  if (!isIntegrationConnectMessage(event, selfOrigin)) return false;
  return completionMatches(event.data, target);
}
