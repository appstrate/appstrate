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
 * to the provider OAuth screen or the hosted credential form (issue #769), so
 * the card is auth-type-agnostic.
 *
 * Completion is detected from three signals, in order of immediacy:
 *  1. `postMessage` from the callback popup (same-browser, instant).
 *  2. a `BroadcastChannel` publish (same browser even if the user finished in a
 *     plain tab rather than the popup).
 *  3. a card-local `connection_update` SSE stream (cross-tab/device backstop).
 * The first to fire wins; `resumed` guards against a double resume.
 *
 * The callback page contract — channel name, message type, payload and the
 * origin policy both directions must agree on — lives in
 * `@appstrate/core/connect-handshake`.
 *
 * Layout invariant: the card is mounted from the FIRST frame of the initiate
 * tool call (before the auth url exists) and keeps the SAME two-row geometry
 * across every state — preparing (no `authUrl` yet), idle, pending, error
 * (including `errorText` when the initiate call itself failed), and connected.
 * No state may change the card's height: the transcript must never jump.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAui } from "@assistant-ui/react";
import { AlertTriangleIcon, CheckIcon, Loader2Icon } from "lucide-react";
import { encodePackageIdPath } from "@appstrate/core/naming";
// The correlation rule and the origin check in front of it come from core, not
// from this module: every connect surface applies the same one, and a copy only
// this module could import is what let the SPA's connect popup ship with no
// correlation at all.
import {
  INTEGRATION_CONNECT_CHANNEL,
  acceptsCompletionMessage,
  completionMatches,
} from "@appstrate/core/connect-handshake";
import { Button } from "@appstrate/ui/components/button";
import { useChatHeaders } from "./runtime-context.ts";
import { claimResume, encodeResume, type CompletionDetail, type ResumeMeta } from "./auth-offer.ts";
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
  const headers = getHeaders?.() ?? {};
  const orgId = headers["X-Org-Id"] ?? headers["x-org-id"];
  const spaceId = headers["X-Space-Id"] ?? headers["x-space-id"];
  if (!orgId || !spaceId) return () => {};

  let es: EventSource | null = null;
  try {
    es = new EventSource(
      // `/api/realtime/runs` (the org-wide stream, which also carries
      // `connection_update`) — NOT bare `/api/realtime`, which is not a route
      // (it 404s and isn't auth-skipped), so this backstop never fired.
      //
      // `channels` is declared because this opens one org-wide stream PER
      // rendered card, and the listener below reads `connection_update` only.
      // Without it each card would also carry the org's whole run_log traffic.
      `/api/realtime/runs?orgId=${encodeURIComponent(orgId)}&spaceId=${encodeURIComponent(spaceId)}&channels=connection_update`,
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
  errorText,
}: {
  /** Absent while the initiate call is still streaming — renders "Préparation…". */
  authUrl?: string;
  state?: string;
  packageId?: string;
  /** Set when the initiate call itself failed (no auth url will ever arrive). */
  errorText?: string;
}) {
  const aui = useAui();
  const getHeaders = useChatHeaders();
  const [phase, setPhase] = useState<Phase>("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [meta, setMeta] = useState<ResumeMeta | null>(null);
  const resumed = useRef(false);
  const label = meta?.name ?? packageId ?? "l'intégration";

  // Fetch the integration's display name + icon once so the connect button and
  // the resume chip can show its brand instead of the bare `@scope/name` id.
  useEffect(() => {
    if (!packageId) return;
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
  }, [packageId, getHeaders]);

  const complete = useCallback(
    (ok: boolean, error?: string) => {
      if (resumed.current) return;
      if (!ok) {
        setPhase("error");
        setErrMsg(error ?? "La connexion a échoué.");
        return;
      }
      resumed.current = true;
      // Another card already appended the resume for this package (same
      // completion burst) — show the connected state without a second append,
      // which would fork the conversation into two concurrent turns.
      if (!claimResume(packageId)) {
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
              `L'intégration ${label} est maintenant connectée. Continue la tâche.`,
            ),
          },
        ],
      });
    },
    [aui, label, meta, packageId],
  );

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
    const resume = (d: CompletionDetail) => complete(d.ok !== false, d.error);

    // `acceptsCompletionMessage` validates `ev.origin` before the payload — a
    // `message` listener that skips that check authenticates nothing.
    const onMessage = (ev: MessageEvent) => {
      if (acceptsCompletionMessage(ev, window.location.origin, card)) resume(ev.data);
    };
    window.addEventListener("message", onMessage);

    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        // Same-origin by spec, so there is no origin to validate here.
        bc = new BroadcastChannel(INTEGRATION_CONNECT_CHANNEL);
        bc.onmessage = (ev) => {
          // `completionMatches` is a type guard, so the raw `data` narrows here.
          const d: unknown = ev.data;
          if (completionMatches(d, card)) resume(d);
        };
      } catch {
        bc = null;
      }
    }

    const closeSse = watchConnectionSse(getHeaders, packageId, () => complete(true));

    return () => {
      window.removeEventListener("message", onMessage);
      bc?.close();
      closeSse();
    };
  }, [phase, state, packageId, getHeaders, complete]);

  const start = () => {
    if (!authUrl) return;
    setErrMsg(null);
    setPhase("pending");
    // Keep the opener (no `noopener`) so the callback can postMessage us back.
    const popup = window.open(authUrl, "appstrate_oauth", "width=520,height=680");
    if (!popup) {
      // Popup blocked — fall back to a same-tab navigation; the BroadcastChannel
      // + SSE backstops still resume the (now backgrounded) chat tab.
      window.location.href = authUrl;
    }
  };

  const connected = phase === "done" || phase === "connected";
  const initiateFailed = !authUrl && !!errorText;
  const preparing = !authUrl && !initiateFailed;

  // One shell for every state: row 1 (h-5, sentence) + row 2 (h-9, action or
  // outcome). Fixed row heights so state transitions — preparing → idle →
  // pending → connected/error — are 0px layout changes.
  return (
    <div className="bg-card text-card-foreground my-3 flex w-full flex-col gap-2 rounded-lg border px-3 py-3 text-sm">
      <div className="flex h-5 items-center gap-2">
        <IntegrationIcon src={meta?.icon} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {connected ? (
            <>
              <span className="font-medium">{label}</span> connectée.
            </>
          ) : initiateFailed ? (
            <>
              Connexion de <span className="font-medium">{label}</span> impossible.
            </>
          ) : (
            <>
              Connecte <span className="font-medium">{label}</span> pour continuer.
            </>
          )}
        </span>
      </div>
      <div className="flex h-9 items-center gap-2">
        {connected ? (
          <span className="text-primary flex items-center gap-1.5 text-xs">
            <CheckIcon className="size-3.5 shrink-0" />
            Connexion active
          </span>
        ) : initiateFailed ? (
          <span className="text-destructive flex min-w-0 items-center gap-1 text-xs">
            <AlertTriangleIcon className="size-3.5 shrink-0" />
            <span className="truncate">{errorText}</span>
          </span>
        ) : (
          <>
            <Button
              type="button"
              onClick={start}
              disabled={preparing || phase === "pending"}
              className="gap-2"
            >
              {preparing || phase === "pending" ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : null}
              {preparing
                ? "Préparation…"
                : phase === "pending"
                  ? "En attente de connexion…"
                  : "Connecter"}
            </Button>
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
