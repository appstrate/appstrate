// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "../components/spinner";
import { CredentialFields } from "../components/integration-connect/credential-fields";
import { IntegrationIcon } from "../components/integration-icon";
import type { IntegrationManifestAuth } from "../hooks/use-integrations";
import { browserUseInteractionUrl, readConnectEventStream } from "./hosted-connect-sse";

/**
 * Standalone hosted connect form (issue #769) — the non-OAuth half of the
 * unified connect portal. Reached when the dispatch endpoint
 * (`GET /api/integrations/connect/start`) redirects a non-OAuth session here.
 *
 * Authentication is the httpOnly page cookie pinned during dispatch — NOT the
 * platform session — so this page renders standalone (members AND embedded
 * end-users), outside the authenticated app shell. Context comes from
 * `GET /connect/context`; the secret is entered here and POSTed directly to
 * `/connect/submit` (never through the model or the chat bundle).
 */

// Must match `apps/api/src/lib/oauth-popup-html.ts` so the chat ConnectCard
// (postMessage / BroadcastChannel listener) auto-resumes on success.
const INTEGRATION_BROADCAST_CHANNEL = "appstrate_integration";
const INTEGRATION_MESSAGE_TYPE = "appstrate:integration_connection";
const CSRF_HEADER = "x-connect-csrf";

interface ConnectContext {
  package_id: string;
  auth_key: string;
  display_name: string;
  icon: string | null;
  auth: IntegrationManifestAuth;
  connection_id: string | null;
  csrf: string | null;
  companion: {
    available: true;
    target_provider: "browser-use-cloud" | "process";
  } | null;
}

type Phase = "loading" | "form" | "submitting" | "companion" | "done" | "error";

interface CompanionAttempt {
  endpoint: string;
  token: string;
}

function signalSuccess(packageId: string): void {
  const detail = { type: INTEGRATION_MESSAGE_TYPE, ok: true, packageId };
  try {
    // Broadcast to the opener regardless of origin (`"*"`), matching the OAuth
    // callback page (`oauth-popup-html.ts`). The payload is a non-secret
    // completion ping (`{ type, ok, packageId }`) — no credential ever crosses
    // it — and a same-origin lock would silently starve EMBEDDED integrators
    // (cross-origin opener) of the signal, leaving them only the popup-close
    // fallback. Our own SPA listener still validates `e.origin` on receipt, so
    // a wide targetOrigin here doesn't weaken what we trust inbound.
    if (window.opener) window.opener.postMessage(detail, "*");
  } catch {
    /* opener gone — fall through to the channel */
  }
  try {
    const bc = new BroadcastChannel(INTEGRATION_BROADCAST_CHANNEL);
    bc.postMessage(detail);
    bc.close();
  } catch {
    /* BroadcastChannel unsupported — the SSE backstop still fires server-side */
  }
}

export function HostedConnectPage() {
  const { t } = useTranslation("settings");
  const [phase, setPhase] = useState<Phase>("loading");
  const [context, setContext] = useState<ConnectContext | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [interactionUrl, setInteractionUrl] = useState<string | null>(null);
  const [companionAttempt, setCompanionAttempt] = useState<CompanionAttempt | null>(null);
  // Technical reason behind a context-load failure (HTTP status or network
  // error). Shown under the generic body so an invalid/expired link, a removed
  // integration, and a network outage don't all look identical.
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/integrations/connect/context", {
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ctx = (await res.json()) as ConnectContext;
        if (cancelled) return;
        setContext(ctx);
        setPhase("form");
      } catch (err) {
        if (cancelled) return;
        setErrorDetail(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!companionAttempt || !context) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(companionAttempt.endpoint, {
          headers: { Authorization: `Bearer ${companionAttempt.token}` },
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = (await response.json()) as {
          status?: unknown;
          interaction_url?: unknown;
          error_code?: unknown;
        };
        if (cancelled) return;
        if (status.status === "complete") {
          signalSuccess(context.package_id);
          setPhase("done");
          setTimeout(() => window.close(), 1200);
          return;
        }
        if (status.status === "failed") {
          throw new Error(
            typeof status.error_code === "string"
              ? status.error_code
              : "The transferred session could not be verified.",
          );
        }
        if (typeof status.interaction_url === "string") {
          setInteractionUrl(browserUseInteractionUrl(status.interaction_url));
        }
        timer = setTimeout(poll, 1000);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("form");
        setCompanionAttempt(null);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [companionAttempt, context]);

  const startCompanion = async () => {
    if (!context?.csrf) return;
    setError(null);
    setInteractionUrl(null);
    try {
      const response = await fetch("/api/integrations/connect/companion/attempts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: context.csrf },
        body: JSON.stringify({ target_provider: context.companion?.target_provider }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(problem?.detail ?? `HTTP ${response.status}`);
      }
      const result = (await response.json()) as { companion_url?: unknown };
      if (typeof result.companion_url !== "string") throw new Error("Malformed companion link");
      const link = new URL(result.companion_url);
      const endpoint = link.searchParams.get("endpoint");
      const token = link.searchParams.get("token");
      if (!endpoint || !token) throw new Error("Malformed companion capability");
      setCompanionAttempt({ endpoint, token });
      setPhase("companion");
      window.location.assign(result.companion_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("form");
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // A missing CSRF nonce means the page session is broken (cookie cleared or
    // context never carried one) — surface it instead of a dead-button no-op.
    if (!context?.csrf) {
      setError(t("integration.connect.hosted.errorBody"));
      return;
    }
    setPhase("submitting");
    setError(null);
    setInteractionUrl(null);
    let interactionWasRequired = false;
    try {
      const res = await fetch("/api/integrations/connect/submit", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          [CSRF_HEADER]: context.csrf,
        },
        body: JSON.stringify({ credentials: values }),
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(problem?.detail ?? `submit ${res.status}`);
      }
      const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/event-stream")) {
        let completed = false;
        await readConnectEventStream(res, async ({ event, data }) => {
          if (event === "interaction") {
            const payload = data as { url?: unknown };
            interactionWasRequired = true;
            setInteractionUrl(browserUseInteractionUrl(payload?.url));
            return;
          }
          if (event === "error") {
            const problem = data as { detail?: unknown };
            throw new Error(
              typeof problem?.detail === "string"
                ? problem.detail
                : "The browser connection could not be completed.",
            );
          }
          if (event === "complete") completed = true;
        });
        if (!completed) throw new Error("The browser connection ended before completion.");
      } else {
        await res.json();
      }
      signalSuccess(context.package_id);
      setPhase("done");
      // Close the popup/tab after a short confirmation, mirroring the OAuth page.
      setTimeout(() => {
        try {
          window.close();
        } catch {
          /* not a popup — the confirmation stays visible */
        }
      }, 1200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (interactionWasRequired) {
        setErrorDetail(message);
        setPhase("error");
      } else {
        setError(message);
        setPhase("form");
      }
    }
  };

  return (
    <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        {phase === "loading" && (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-2 text-center">
            <h1 className="text-lg font-semibold">{t("integration.connect.hosted.errorTitle")}</h1>
            <p className="text-muted-foreground text-sm">
              {t("integration.connect.hosted.errorBody")}
            </p>
            {errorDetail && (
              <p className="text-muted-foreground/60 font-mono text-xs">{errorDetail}</p>
            )}
          </div>
        )}

        {phase === "done" && (
          <div className="space-y-2 text-center">
            <h1 className="text-lg font-semibold text-green-400">
              {t("integration.connect.hosted.doneTitle")}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t("integration.connect.hosted.doneBody")}
            </p>
          </div>
        )}

        {(phase === "form" || phase === "submitting" || phase === "companion") && context && (
          <>
            <div className="flex items-center gap-3">
              <IntegrationIcon src={context.icon ?? undefined} />
              <h1 className="text-lg font-semibold">
                {t("integration.connect.hosted.title", { display: context.display_name })}
              </h1>
            </div>
            <form className="space-y-4" onSubmit={submit}>
              {context.companion && (
                <div className="border-border bg-muted/30 space-y-3 rounded-md border p-4">
                  <p className="text-sm">{t("integration.connect.hosted.companionBody")}</p>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={phase !== "form"}
                    onClick={() => void startCompanion()}
                  >
                    {phase === "companion"
                      ? t("integration.connect.hosted.companionWaiting")
                      : t("integration.connect.hosted.companionOpen")}
                  </Button>
                </div>
              )}
              {context.companion && (
                <div className="text-muted-foreground flex items-center gap-3 text-xs">
                  <span className="bg-border h-px flex-1" />
                  <span>{t("integration.connect.hosted.companionAlternative")}</span>
                  <span className="bg-border h-px flex-1" />
                </div>
              )}
              <p className="text-muted-foreground text-sm">
                {t("integration.connect.modal.subtitle", { type: context.auth.type })}
              </p>
              <CredentialFields auth={context.auth} values={values} onChange={setValues} />
              {phase === "submitting" && !interactionUrl && (
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Spinner />
                  <span>{t("integration.connect.hosted.browserStarting")}</span>
                </div>
              )}
              {(phase === "submitting" || phase === "companion") && interactionUrl && (
                <div className="border-border bg-muted/30 space-y-3 rounded-md border p-4">
                  <p className="text-sm">
                    {t("integration.connect.hosted.browserInteractionBody")}
                  </p>
                  <Button asChild className="w-full">
                    <a href={interactionUrl} target="_blank" rel="noopener noreferrer">
                      {t("integration.connect.hosted.browserOpen")}
                    </a>
                  </Button>
                  <p className="text-muted-foreground text-xs">
                    {t("integration.connect.hosted.browserWaiting")}
                  </p>
                </div>
              )}
              {error && <p className="text-sm text-red-400">{error}</p>}
              <Button
                type="submit"
                className="w-full"
                disabled={phase === "submitting" || phase === "companion"}
              >
                {t("integration.connect.btn.save")}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
