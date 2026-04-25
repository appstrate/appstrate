// SPDX-License-Identifier: Apache-2.0

/**
 * Register page — redirects to the OIDC signup flow when configured, falls
 * back to the built-in RegisterForm when the OIDC module is not loaded.
 *
 * In closed mode (issue #228), if `AUTH_BOOTSTRAP_OWNER_EMAIL` is set
 * server-side, the email field is pre-filled and locked so the bootstrap
 * owner can't accidentally diverge from the env-configured account. The
 * server-side signup gate is the real authority — this is just UX.
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "../components/auth-layout";
import { RegisterForm } from "../components/register-form";
import { Spinner } from "../components/spinner";
import { useAppConfig } from "../hooks/use-app-config";
import { deriveDisplayNameFromEmail } from "../lib/derive-display-name";

export function RegisterPage() {
  const { t } = useTranslation(["settings"]);
  const { bootstrapOwnerEmail } = useAppConfig();
  const oidcConfig = (window.__APP_CONFIG__ as unknown as Record<string, unknown>)?.oidc;

  useEffect(() => {
    if (oidcConfig) {
      import("../modules/oidc/lib/oidc").then(({ startOidcSignup }) => {
        startOidcSignup();
      });
    }
  }, [oidcConfig]);

  if (oidcConfig) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <AuthLayout>
      {bootstrapOwnerEmail ? (
        <div className="flex flex-col gap-4">
          <div className="border-primary/30 bg-primary/5 rounded-lg border px-4 py-3 text-sm">
            <p className="font-medium">{t("login.bootstrapTitle")}</p>
            <p className="text-muted-foreground mt-1">
              {t("login.bootstrapBody", { email: bootstrapOwnerEmail })}
            </p>
          </div>
          {/*
           * Route the bootstrap owner through the rest of the onboarding
           * flow so they can configure their first model, providers, and
           * invite teammates. The org is already created by the
           * after-hook, so `/onboarding/create` auto-skips to the next
           * active step (currently `/onboarding/model` in OSS) — see
           * `create-step.tsx` "skip to next step" effect.
           */}
          <RegisterForm
            fixedEmail={bootstrapOwnerEmail}
            defaultDisplayName={deriveDisplayNameFromEmail(bootstrapOwnerEmail)}
            redirectAfterSignup="/onboarding/create"
          />
        </div>
      ) : (
        <RegisterForm />
      )}
    </AuthLayout>
  );
}
