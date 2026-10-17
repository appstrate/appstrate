// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";
import { CredentialFields } from "../components/integration-connect/credential-fields";
import { initialCredentialValues } from "../components/integration-connect/credential-schema";
import {
  initialVariableValues,
  variableFields,
} from "../components/integration-connect/connection-variables-schema";
import { VariableFields } from "../components/integration-connect/variable-fields";
import { HandoffSteps, type HandoffStep } from "../components/integration-connect/handoff-steps";
import { PackageIcon } from "../components/package-icon";
import { client, type paths } from "../api/client";
import { publishConnectCompletion } from "../lib/connect-completion";
import type { IntegrationManifestAuth } from "../hooks/use-integrations";
import { errorMessage } from "../lib/mutation-error";
import {
  missingVariables,
  submitHostedConnect,
  variableFieldErrors,
} from "../lib/hosted-connect-submit";

/**
 * Standalone hosted connect form (the form half of the connect portal), reached
 * when `GET /api/integrations/connect/start` redirects here: a non-OAuth
 * session, or an OAuth one that must first collect connection variables.
 *
 * Auth is the httpOnly page cookie pinned at dispatch, NOT the platform session,
 * so it renders outside the app shell. The secret is POSTed directly to
 * `/connect/submit` (never through the model or chat bundle). The typed client
 * is safe here: `/api/integrations/connect/*` skips the auth pipeline and takes
 * scope + actor from the cookie claims, so a leftover `X-Org-Id` is never read.
 */

/** The spec leaves the manifest `auth` block open: narrow it for `<CredentialFields>`. */
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
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [variableErrors, setVariableErrors] = useState<Record<string, string>>({});
  // Steps left to do on the target host for a minted credential (nothing secret).
  const [handoffSteps, setHandoffSteps] = useState<HandoffStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reason behind a context-load failure, so expired links and outages look different.
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
        // Seed manifest defaults: a visible value must be a submitted value.
        setValues(initialCredentialValues(ctx.auth));
        setVariableValues(initialVariableValues(ctx.variables));
        setPhase("form");
      } catch (err) {
        if (cancelled) return;
        setErrorDetail(errorMessage(err));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Back from the authorization server, the bfcache restores a submitting page; the cookie
  // survives until the OAuth callback, so the form can be submitted again.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setPhase((p) => (p === "submitting" ? "form" : p));
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const fields = context?.variables ? variableFields(context.variables.schema) : [];
  const variableLabels = Object.fromEntries(fields.map((f) => [f.name, f.title ?? f.name]));
  const isOAuth = context?.auth.type === "oauth2";
  const variablesLocked = Object.keys(context?.variables?.values ?? {}).length > 0;

  const changeVariable = (name: string, value: string) => {
    setVariableValues((prev) => ({ ...prev, [name]: value }));
    setVariableErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // A missing CSRF nonce means a broken page session: surface it, not a dead button.
    if (!context?.csrf) {
      setError(t("integration.connect.hosted.errorBody"));
      return;
    }
    const variableNames = context.variables ? fields.map((f) => f.name) : null;
    const missing = missingVariables(variableNames ?? [], variableValues);
    if (missing.length > 0) {
      setVariableErrors(
        Object.fromEntries(
          missing.map((name) => [name, t("integration.connect.variables.required")]),
        ),
      );
      return;
    }
    const csrf = context.csrf;
    setPhase("submitting");
    setError(null);
    setVariableErrors({});
    try {
      const outcome = await submitHostedConnect(
        {
          authType: context.auth.type,
          credentials: values,
          variableNames,
          variableValues,
        },
        {
          post: async (body) =>
            (
              await client.POST("/api/integrations/connect/submit", {
                params: { header: { "x-connect-csrf": csrf } },
                body,
              })
            ).data,
          navigate: (url) => window.location.assign(url),
        },
      );
      // The OAuth callback announces the result; the form stays disabled until the window leaves.
      if (outcome.kind === "redirected") return;
      // Announce now: the opener does not close this window, so the install block stays up.
      publishConnectCompletion(
        { ok: true, packageId: context.packageId },
        window.opener as Window | null,
        window.location.origin,
      );
      if (outcome.handoffSteps.length > 0) setHandoffSteps(outcome.handoffSteps);
      else setTimeout(closeWindow, 1200);
      setPhase("done");
    } catch (err) {
      const { byName, complete } = variableFieldErrors(err, variableLabels);
      setVariableErrors(byName);
      setError(complete ? null : errorMessage(err));
      setPhase("form");
    }
  };

  return (
    <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-4">
      {/* The install block is a shell script — wrapping it into a 28rem column
          would make it unreadable, so that one phase gets a wider page. */}
      <div className={`flex w-full flex-col gap-6 ${handoffSteps ? "max-w-2xl" : "max-w-md"}`}>
        {phase === "loading" && (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        )}

        {phase === "error" && (
          <div className="flex flex-col gap-2 text-center">
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
          <div className="flex flex-col gap-5" data-testid="connect-handoff">
            <div>
              <h1 className="text-lg font-semibold">
                {t("integration.connect.handoffPanel.title")}
              </h1>
              <p className="text-muted-foreground mt-1 text-sm">
                {t("integration.connect.handoffPanel.body")}
              </p>
            </div>

            <HandoffSteps steps={handoffSteps} />

            <Button
              type="button"
              className="w-full"
              data-testid="handoff-done"
              onClick={() => {
                // In a full tab `close()` is a no-op: fall back to the done message.
                setHandoffSteps(null);
                closeWindow();
              }}
            >
              {t("integration.connect.handoffPanel.doneBtn")}
            </Button>
          </div>
        )}

        {phase === "done" && !handoffSteps && (
          <div className="flex flex-col gap-2 text-center">
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
              <PackageIcon type="integration" icon={context.icon} />
              <h1 className="text-lg font-semibold">
                {t("integration.connect.hosted.title", { display: context.display_name })}
              </h1>
            </div>
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <p className="text-muted-foreground text-sm">
                {isOAuth
                  ? t("integration.connect.variables.oauthSubtitle")
                  : t("integration.connect.modal.subtitle", { type: context.auth.type })}
              </p>
              <VariableFields
                fields={fields}
                values={variableValues}
                onChange={changeVariable}
                errors={variableErrors}
                readOnly={variablesLocked}
              />
              {/* oauth2: the credential comes from the authorization server, not this form. */}
              {!isOAuth && (
                <CredentialFields auth={context.auth} values={values} onChange={setValues} />
              )}
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={phase === "submitting"}>
                {isOAuth ? t("onboarding.next") : t("common:btn.save")}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
