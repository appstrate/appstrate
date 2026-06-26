// SPDX-License-Identifier: Apache-2.0

/**
 * In-chat OAuth connect card.
 *
 * When the assistant calls `initiateIntegrationOAuth`, the platform returns an
 * `auth_url`. Instead of dumping that raw link (which, opened in a full tab,
 * dead-ends on a blank `window.close()` page), we render a one-click button
 * that opens the flow in a popup and *resumes the conversation automatically*
 * once the connection lands — no copy-paste, no "did it work?" round-trip.
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
import { AlertTriangleIcon, CheckIcon, Loader2Icon, PlugZapIcon } from "lucide-react";
import { Button } from "./button.tsx";
import { useChatHeaders } from "./runtime-context.ts";

const BROADCAST_CHANNEL = "appstrate_integration";
const MESSAGE_TYPE = "appstrate:integration_connection";

interface CompletionDetail {
  type?: string;
  ok?: boolean;
  state?: string;
  packageId?: string;
  error?: string;
}

type Phase = "idle" | "pending" | "done" | "error";

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
      `/api/realtime?orgId=${encodeURIComponent(orgId)}&applicationId=${encodeURIComponent(appId)}`,
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
  const resumed = useRef(false);
  const label = packageId ?? "l'intégration";

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
            text: `L'intégration ${label} est maintenant connectée. Continue la tâche.`,
          },
        ],
      });
    },
    [thread, label],
  );

  // Listen from mount until the connection lands — NOT only after the user
  // clicks our button. The assistant may also paste the raw auth_url as a link;
  // if the user opens that in a full tab, completion arrives via the callback
  // page's BroadcastChannel (or the SSE backstop), and we must still resume.
  useEffect(() => {
    if (phase === "done") return;

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

  if (phase === "done") {
    return (
      <div className="bg-card text-card-foreground my-3 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm">
        <CheckIcon className="text-primary size-4 shrink-0" />
        <span className="flex-1 truncate">{label} connectée — reprise…</span>
      </div>
    );
  }

  return (
    <div className="bg-card text-card-foreground my-3 flex w-full flex-col gap-2 rounded-lg border px-3 py-3 text-sm">
      <div className="flex items-center gap-2">
        <PlugZapIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="flex-1">
          Connecte <code className="text-xs">{label}</code> pour continuer.
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
