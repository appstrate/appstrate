// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "../components/spinner";
import { CredentialFields } from "../components/integration-connect/credential-fields";
import { initialCredentialValues } from "../components/integration-connect/credential-schema";
import { HandoffSteps, type HandoffStep } from "../components/integration-connect/handoff-steps";
import { IntegrationIcon } from "../components/integration-icon";
import { client, type paths } from "../api/client";
import { publishConnectCompletion } from "../lib/connect-completion";
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
 *
 * Both calls go through the typed client. That is safe despite the page's
 * non-session auth: `/api/integrations/connect/*` short-circuits the whole
 * auth pipeline server-side (`skipAuth` in `lib/auth-pipeline.ts`) and both
 * handlers derive scope + actor from the page-cookie claims alone, so the
 * `X-Org-Id` / `X-Space-Id` the client middleware may inject from a
 * leftover localStorage selection is never read.
 */

/**
 * The spec leaves the manifest `auth` block open (`additionalProperties`), so
 * the generated type is a bare record — narrow it for `<CredentialFields>`.
 */
type ConnectContext = Omit<
  paths["/api/integrations/connect/context"]["get"]["responses"][200]["content"]["application/json"],
  "auth"
> & { auth: IntegrationManifestAuth };

type Phase = "loading" | "form" | "submitting" | "done" | "error";

const closeWindow = () => {
  try {
    window.close();
  } catch {
    /* not a popup — the confirmation stays visible */
  }
};

export function HostedConnectPage() {
  const { t } = useTranslation("settings");
  const [phase, setPhase] = useState<Phase>("loading");
  const [context, setContext] = useState<ConnectContext | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  // What the user must still do on the target host for a minted credential.
  // Nothing here is secret — the private half never leaves the server.
  const [handoffSteps, setHandoffSteps] = useState<HandoffStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Technical reason behind a context-load failure (HTTP status or network
  // error). Shown under the generic body so an invalid/expired link, a removed
  // integration, and a network outage don't all look identical.
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Non-2xx throws via the client middleware, so `data` is defined here.
        const { data } = await client.GET("/api/integrations/connect/context");
        if (cancelled) return;
        const ctx = data as ConnectContext;
        setContext(ctx);
        // Seed the defaults the manifest declares, so a value the user can see
        // in the form is a value the form will actually submit.
        setValues(initialCredentialValues(ctx.auth));
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
    try {
      // Non-2xx throws `ApiError` (RFC 9457 `detail`) via the client middleware.
      const { data } = await client.POST("/api/integrations/connect/submit", {
        params: { header: { "x-connect-csrf": context.csrf } },
        body: { credentials: values },
      });
      // The connection exists: announce it now. The popup opener does not close
      // this window, so an install block below stays up until the user is done.
      publishConnectCompletion(
        { ok: true, packageId: context.package_id },
        window.opener as Window | null,
        window.location.origin,
      );
      const minted = data?.handoff_steps;
      if (minted && minted.length > 0) setHandoffSteps(minted);
      else setTimeout(closeWindow, 1200);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("form");
    }
  };

  return (
    <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-4">
      {/* The install block is a shell script — wrapping it into a 28rem column
          would make it unreadable, so that one phase gets a wider page. */}
      <div className={`w-full space-y-6 ${handoffSteps ? "max-w-2xl" : "max-w-md"}`}>
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

        {phase === "done" && handoffSteps && (
          <div className="space-y-5" data-testid="connect-provisioned">
            <div>
              <h1 className="text-lg font-semibold">
                {t("integration.connect.provisioned.title")}
              </h1>
              <p className="text-muted-foreground mt-1 text-sm">
                {t("integration.connect.provisioned.body")}
              </p>
            </div>

            <HandoffSteps steps={handoffSteps} />

            <Button
              type="button"
              className="w-full"
              data-testid="provisioned-done"
              onClick={() => {
                // In a full tab `close()` is a no-op: fall back to the done message.
                setHandoffSteps(null);
                closeWindow();
              }}
            >
              {t("integration.connect.provisioned.doneBtn")}
            </Button>
          </div>
        )}

        {phase === "done" && !handoffSteps && (
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
