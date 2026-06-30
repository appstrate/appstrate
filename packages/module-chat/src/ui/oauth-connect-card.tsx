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
 * The callback page contract lives in `apps/api/src/lib/oauth-popup-html.ts`
 * (channel name + message type must match the literals below).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useThreadRuntime } from "@assistant-ui/react";
import { AlertTriangleIcon, CheckIcon, Loader2Icon } from "lucide-react";
import { encodePackageIdPath } from "@appstrate/core/naming";
import { Button } from "./button.tsx";
import { useChatHeaders } from "./runtime-context.ts";
import { encodeResume, type ResumeMeta } from "./auth-offer.ts";
import { IntegrationIcon } from "./integration-icon.tsx";

const BROADCAST_CHANNEL = "appstrate_integration";
const MESSAGE_TYPE = "appstrate:integration_connection";

interface CompletionDetail {
  type?: string;
  ok?: boolean;
  state?: string;
  packageId?: string;
  error?: string;
}

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
  const appId = headers["X-Application-Id"] ?? headers["x-application-id"];
  if (!orgId || !appId) return () => {};

  let es: EventSource | null = null;
  try {
    es = new EventSource(
      // `/api/realtime/runs` (the org-wide stream, which also carries
      // `connection_update`) — NOT bare `/api/realtime`, which is not a route
      // (it 404s and isn't auth-skipped), so this backstop never fired.
      `/api/realtime/runs?orgId=${encodeURIComponent(orgId)}&applicationId=${encodeURIComponent(appId)}`,
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
}: {
  authUrl: string;
  state?: string;
  packageId?: string;
}) {
  const thread = useThreadRuntime();
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
      setPhase("done");
      thread.append({
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
    [thread, label, meta, packageId],
  );

  // Listen from mount until the connection lands — NOT only after the user
  // clicks our button. The assistant may also paste the raw auth_url as a link;
  // if the user opens that in a full tab, completion arrives via the callback
  // page's BroadcastChannel (or the SSE backstop), and we must still resume.
  useEffect(() => {
    if (phase === "done" || phase === "connected") return;

    const matches = (d: CompletionDetail | undefined) =>
      !!d && d.type === MESSAGE_TYPE && (!state || !d.state || d.state === state);

    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as CompletionDetail | undefined;
      if (matches(d)) complete(d!.ok !== false, d!.error);
    };
    window.addEventListener("message", onMessage);

    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        bc = new BroadcastChannel(BROADCAST_CHANNEL);
        bc.onmessage = (ev) => {
          const d = ev.data as CompletionDetail | undefined;
          if (matches(d)) complete(d!.ok !== false, d!.error);
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

  if (phase === "done" || phase === "connected") {
    return (
      <div className="bg-card text-card-foreground my-3 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm">
        <IntegrationIcon src={meta?.icon} className="size-4 shrink-0" />
        <span className="flex-1 truncate">{label} connectée</span>
        <CheckIcon className="text-primary size-4 shrink-0" />
      </div>
    );
  }

  return (
    <div className="bg-card text-card-foreground my-3 flex w-full flex-col gap-2 rounded-lg border px-3 py-3 text-sm">
      <div className="flex items-center gap-2">
        <IntegrationIcon src={meta?.icon} className="size-4 shrink-0" />
        <span className="flex-1">
          Connecte <span className="font-medium">{label}</span> pour continuer.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={start} disabled={phase === "pending"} className="gap-2">
          {phase === "pending" ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {phase === "pending" ? "En attente de connexion…" : "Connecter"}
        </Button>
        {phase === "error" && errMsg ? (
          <span className="text-destructive flex items-center gap-1 text-xs">
            <AlertTriangleIcon className="size-3.5" />
            {errMsg}
          </span>
        ) : null}
      </div>
    </div>
  );
}
