// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Spinner } from "../components/spinner";
import { CredentialFields } from "../components/integration-connect/credential-fields";
import { IntegrationIcon } from "../components/integration-icon";
import type { IntegrationManifestAuth } from "../hooks/use-integrations";

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
}

type Phase = "loading" | "form" | "submitting" | "done" | "error";

function signalSuccess(packageId: string): void {
  const detail = { type: INTEGRATION_MESSAGE_TYPE, ok: true, packageId };
  try {
    if (window.opener) window.opener.postMessage(detail, "*");
  } catch {
    /* opener gone or cross-origin — fall through to the channel */
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/integrations/connect/context", {
          credentials: "include",
        });
        if (!res.ok) throw new Error(`context ${res.status}`);
        const ctx = (await res.json()) as ConnectContext;
        if (cancelled) return;
        setContext(ctx);
        setPhase("form");
      } catch {
        if (cancelled) return;
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!context?.csrf) return;
    setPhase("submitting");
    setError(null);
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
      setError(err instanceof Error ? err.message : String(err));
      setPhase("form");
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

        {(phase === "form" || phase === "submitting") && context && (
          <>
            <div className="flex items-center gap-3">
              <IntegrationIcon src={context.icon ?? undefined} />
              <h1 className="text-lg font-semibold">
                {t("integration.connect.hosted.title", { display: context.display_name })}
              </h1>
            </div>
            <form className="space-y-4" onSubmit={submit}>
              <p className="text-muted-foreground text-sm">
                {t("integration.connect.modal.subtitle", { type: context.auth.type })}
              </p>
              <CredentialFields auth={context.auth} values={values} onChange={setValues} />
              {error && <p className="text-sm text-red-400">{error}</p>}
              <Button type="submit" className="w-full" disabled={phase === "submitting"}>
                {t("integration.connect.btn.save")}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
