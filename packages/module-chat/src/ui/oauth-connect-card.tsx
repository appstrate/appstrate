// SPDX-License-Identifier: Apache-2.0

/**
 * In-chat integration connect card.
 *
 * When the assistant calls `initiateIntegrationConnect`, the platform returns a
 * URL to open. Instead of dumping that raw link (which, opened in a full tab,
 * dead-ends on a blank
 * `window.close()` page), we render a one-click button that opens the flow in a
 * popup and *resumes the conversation automatically* once the connection lands
 * — no copy-paste, no "did it work?" round-trip. The URL dispatches server-side
 * to the provider OAuth screen or the hosted credential form, so
 * the card is auth-type-agnostic.
 *
 * Completion is detected from three signals, in order of immediacy:
 *  1. `postMessage` from the callback popup (same-browser, instant).
 *  2. a `BroadcastChannel` publish (same browser even if the user finished in a
 *     plain tab rather than the popup).
 *  3. a card-local `connection_update` SSE stream (cross-tab/device backstop).
 * A failure settles at once and leaves the card retryable; a success waits for
 * the card's popup to close — see `connect-waiter.ts`. `resumed` guards against
 * a double resume.
 *
 * The callback page contract — channel name, message type, payload and the
 * origin policy both directions must agree on — lives in
 * `@appstrate/core/connect-handshake`.
 *
 * Layout invariant: the card is mounted from the FIRST frame of the initiate
 * tool call (before the auth url exists) and keeps the SAME two-row geometry
 * across every state — preparing (no `authUrl` yet), idle, pending, error
 * (including `errorText` when the initiate call itself failed), expired (the
 * link lapsed unused: no button), and connected.
 * No state may change the card's height: the transcript must never jump.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAui } from "@assistant-ui/react";
import { AlertTriangleIcon, CheckIcon } from "lucide-react";
import { encodePackageIdPath } from "@appstrate/core/naming";
import { realtimeRunsUrl } from "@appstrate/core/realtime-url";
// The correlation rule and the origin check in front of it come from core, not
// from this module: every connect surface applies the same one, and a copy only
// this module could import is what let the SPA's connect popup ship with no
// correlation at all.
import {
  CONNECT_POPUP_FEATURES,
  connectPopupName,
  listenConnectCompletion,
} from "@appstrate/core/connect-handshake";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";
import { useChatHeaders, useChatHost } from "./runtime-context.ts";
import { sentenceWithName } from "./sentence-with-name.tsx";
import { orgSpaceFromHeaders } from "./run-events.ts";
import {
  claimResume,
  encodeResume,
  isOfferExpired,
  resumeInstruction,
  type CompletionDetail,
  type ResumeMeta,
} from "./auth-offer.ts";
import { createConnectWaiter, routeCompletion } from "./connect-waiter.ts";
import { IntegrationIcon } from "./integration-icon.tsx";

type Phase = "idle" | "pending" | "done" | "connected" | "error";

/**
 * Open a short-lived SSE stream that resolves when a `connection_update` for
 * `packageId` arrives. Returns a cleanup fn (always — even on the no-op path).
 */
function watchConnectionSse(
  getHeaders: (() => Record<string, string>) | null,
  packageId: string | undefined,
  onHit: () => void,
): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const { orgId, spaceId, viewAs } = orgSpaceFromHeaders(getHeaders?.() ?? {});
  if (!orgId || !spaceId) return () => {};

  let es: EventSource | null = null;
  try {
    es = new EventSource(
      // The org-wide stream (it also carries `connection_update`), declared to
      // `connection_update` alone: one stream is opened PER rendered card and
      // the listener below reads nothing else. A role preview travels as
      // `view_as` — the realtime routes REFUSE the header — and the effect that
      // opens this depends on `getHeaders`, whose identity moves with the
      // persona, so entering or leaving reconnects.
      realtimeRunsUrl({ orgId, spaceId, channels: ["connection_update"], viewAs }),
      { withCredentials: true },
    );
    es.addEventListener("connection_update", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          operation?: string;
          integrationPackageId?: string;
        };
        if (d.operation === "DELETE") return;
        if (!packageId || d.integrationPackageId === packageId) onHit();
      } catch {
        // A malformed frame is not actionable; the other signals still cover us.
      }
    });
  } catch {
    return () => {};
  }
  return () => es?.close();
}

export function OAuthConnectCard({
  authUrl,
  state,
  packageId,
  toolCallId,
  errorText,
  runStarted = false,
  expiresAt,
}: {
  /** Absent while the initiate call is still streaming — renders the preparing state. */
  authUrl?: string;
  state?: string;
  packageId?: string;
  /**
   * Tool call this card was rendered from. Several cards share one when a
   * run-kickoff 409 lists several integrations to connect; it is the second
   * axis of the resume claim (see {@link claimResume}).
   */
  toolCallId?: string;
  /** Set when the initiate call itself failed (no auth url will ever arrive). */
  errorText?: string;
  /** The offer came from a run that started without the integration. */
  runStarted?: boolean;
  /** RFC 3339 expiry of the connect session behind `authUrl`. */
  expiresAt?: string;
}) {
  const aui = useAui();
  const getHeaders = useChatHeaders();
  const { can, t } = useChatHost();
  // Without `integrations:read` the chip keeps the bare package id.
  const readsIntegration = can("integrations:read");
  const [phase, setPhase] = useState<Phase>("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [meta, setMeta] = useState<ResumeMeta | null>(null);
  const [expired, setExpired] = useState(() => isOfferExpired(expiresAt));
  const resumed = useRef(false);
  const label = meta?.name ?? packageId ?? t("connect.integrationFallback");

  // Fetch the integration's display name + icon once so the connect button and
  // the resume chip can show its brand instead of the bare `@scope/name` id.
  useEffect(() => {
    if (!packageId || !readsIntegration) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/integrations/${encodePackageIdPath(packageId)}`, {
          headers: getHeaders?.() ?? {},
          credentials: "include",
        });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          manifest?: { display_name?: string; icon?: string };
          auths?: Array<{ ready?: boolean }>;
        };
        setMeta({
          packageId,
          name: body.manifest?.display_name,
          icon: typeof body.manifest?.icon === "string" ? body.manifest.icon : undefined,
        });
        // Already usable at mount (e.g. a reloaded conversation whose OAuth
        // completed earlier): show the connected state, not the button. Use the
        // server-authoritative `ready` flag — an expired/needs-reconnection
        // connection is NOT ready, so the button correctly stays. Don't resume —
        // that already happened in the original turn.
        const connected = body.auths?.some((a) => a.ready) ?? false;
        if (connected && !resumed.current) {
          resumed.current = true;
          setPhase("connected");
        }
      } catch {
        // Non-fatal: chip falls back to the package id, no brand icon.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [packageId, getHeaders, readsIntegration]);

  const complete = useCallback(
    (ok: boolean, error?: string) => {
      if (resumed.current) return;
      if (!ok) {
        setPhase("error");
        setErrMsg(error ?? t("connect.failed"));
        return;
      }
      resumed.current = true;
      // Another card already appended the resume for this burst — same package,
      // or a sibling card from the same tool call — so show the connected state
      // without a second append, which would fork the conversation into two
      // concurrent turns.
      if (!claimResume({ packageId, toolCallId })) {
        setPhase("connected");
        return;
      }
      setPhase("done");
      aui.thread().append({
        content: [
          {
            type: "text",
            // The marker + encoded meta make the UI render this turn as a
            // discreet connected chip (see thread.tsx UserMessage) rather than a
            // raw user bubble; the human sentence is what the model acts on.
            text: encodeResume(
              meta ?? { packageId: packageId ?? "" },
              resumeInstruction(label, runStarted),
            ),
          },
        ],
      });
    },
    [aui, label, meta, packageId, runStarted, t, toolCallId],
  );

  // One waiter for the card's lifetime: an SSE hit parked until the popup
  // closes must survive the listener effect re-running (phase, headers, meta).
  const [waiter] = useState(createConnectWaiter);
  useEffect(() => {
    waiter.bind(() => complete(true));
  }, [waiter, complete]);
  useEffect(() => {
    waiter.resume();
    return () => waiter.stop();
  }, [waiter]);

  // Listen from mount until the connection lands — NOT only after the user
  // clicks our button. The assistant may also paste the raw auth_url as a link;
  // if the user opens that in a full tab, completion arrives via the callback
  // page's BroadcastChannel (or the SSE backstop), and we must still resume.
  useEffect(() => {
    if (phase === "done" || phase === "connected") return;

    // Correlation lives in `completionMatches` — see its doc. Both identifiers
    // are passed because neither alone covers every flow: the hosted-connect
    // offer carries no state, and a card whose tool args never produced a
    // `packageId` has only the state. A card that ends up with neither takes no
    // package-addressed completion on either carrier — the intended direction,
    // since it cannot tell its own integration's completion from anyone else's.
    const card = { state, packageId };
    const onCompletion = (d: CompletionDetail) =>
      routeCompletion(d, waiter, (error) => complete(false, error));

    const stopListening = listenConnectCompletion(card, onCompletion, window);

    const closeSse = watchConnectionSse(getHeaders, packageId, () => waiter.connected());

    return () => {
      stopListening();
      closeSse();
    };
  }, [phase, state, packageId, getHeaders, waiter, complete]);

  // Flip to the expired state when the session lapses, so the button never
  // outlives its link; `start` re-checks for anything the timer misses.
  useEffect(() => {
    if (expired || !expiresAt) return;
    const delay = Math.max(Date.parse(expiresAt) - Date.now(), 0);
    const timer = setTimeout(() => setExpired(isOfferExpired(expiresAt)), delay);
    return () => clearTimeout(timer);
  }, [expired, expiresAt]);

  const start = () => {
    if (!authUrl) return;
    if (isOfferExpired(expiresAt)) {
      setExpired(true);
      return;
    }
    setErrMsg(null);
    setPhase("pending");
    // Keep the opener (no `noopener`) so the callback can postMessage us back.
    const popup = window.open(authUrl, connectPopupName(packageId), CONNECT_POPUP_FEATURES);
    waiter.popupOpened(popup);
    if (!popup) {
      // Blocked. Never navigate THIS tab to the flow: the conversation that must
      // resume lives here. A link to a new tab replaces the button instead.
      setPopupBlocked(true);
      setPhase("error");
      setErrMsg(t("connect.popupBlocked"));
    }
  };

  const connected = phase === "done" || phase === "connected";
  const initiateFailed = !authUrl && !!errorText;
  const preparing = !authUrl && !initiateFailed;
  // A flow already opened has consumed the link; only an unused one can lapse.
  // Completion listeners stay mounted, so connecting elsewhere still resumes.
  const showExpired = expired && !connected && phase !== "pending";

  // One shell for every state: row 1 (h-5, sentence) + row 2 (h-9, action or
  // outcome). Fixed row heights so state transitions — preparing → idle →
  // pending → connected/error — are 0px layout changes.
  return (
    <div className="bg-card text-card-foreground my-3 flex w-full flex-col gap-2 rounded-lg border px-3 py-3 text-sm">
      <div className="flex h-5 items-center gap-2">
        <IntegrationIcon src={meta?.icon} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {sentenceWithName(
            t,
            connected
              ? "connect.connected"
              : initiateFailed
                ? "connect.initiateFailed"
                : "connect.prompt",
            label,
          )}
        </span>
      </div>
      <div className="flex h-9 items-center gap-2">
        {connected ? (
          <span className="text-primary flex items-center gap-1.5 text-xs">
            <CheckIcon className="size-3.5 shrink-0" />
            {t("connect.active")}
          </span>
        ) : initiateFailed || showExpired ? (
          <span className="text-destructive flex min-w-0 items-center gap-1 text-xs">
            <AlertTriangleIcon className="size-3.5 shrink-0" />
            <span className="truncate">{initiateFailed ? errorText : t("connect.expired")}</span>
          </span>
        ) : (
          <>
            {popupBlocked ? (
              <Button asChild className="shrink-0">
                <a href={authUrl} target="_blank" rel="noopener noreferrer">
                  {t("connect.openInTab")}
                </a>
              </Button>
            ) : (
              <Button
                type="button"
                onClick={start}
                disabled={preparing || phase === "pending"}
                className="gap-2"
              >
                {preparing || phase === "pending" ? <Spinner /> : null}
                {preparing
                  ? t("connect.preparing")
                  : phase === "pending"
                    ? t("connect.waiting")
                    : t("connect.start")}
              </Button>
            )}
            {phase === "error" && errMsg ? (
              <span className="text-destructive flex min-w-0 items-center gap-1 text-xs">
                <AlertTriangleIcon className="size-3.5 shrink-0" />
                <span className="truncate">{errMsg}</span>
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
