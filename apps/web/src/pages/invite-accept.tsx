// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@appstrate/ui/components/button";
import { FieldError } from "@appstrate/ui/components/field";
import { ApiError, client, type paths } from "../api/client";
import { useAuth } from "../hooks/use-auth";
import { useHostedAuthRedirect, isHostedAuthEnabled } from "../hooks/use-hosted-auth-redirect";
import { orgStore } from "../stores/org-store";
import { Spinner } from "@appstrate/ui/components/spinner";
import { AuthLayout } from "../components/auth-layout";
import { AuthLink } from "../components/auth-message";
import { RegisterForm } from "../components/register-form";
import { LoginForm } from "../components/login-form";
import { roleI18nKey } from "../hooks/use-permissions";
import { orgKeys } from "../lib/query-keys";
import { hasVerificationLinkError } from "../lib/auth-errors";

/** Spec response of GET /invite/{token}/info (all fields required, role is an org-role enum). */
type InviteInfo =
  paths["/invite/{token}/info"]["get"]["responses"]["200"]["content"]["application/json"];

/** Map an invitation ApiError code to a translation key, falling back to `fallback`. */
function inviteErrorKey(code: string | null, fallback: string): string {
  switch (code) {
    case "invitation_expired":
      return "invite.expired";
    case "invitation_accepted":
      return "invite.alreadyAccepted";
    case "invitation_cancelled":
      return "invite.cancelled";
    default:
      return fallback;
  }
}

/**
 * Invitation acceptance (`/invite/:token`): loader, then authentication
 * delegator, then an explicit accept.
 *
 * Authentication is delegated to the platform-standard path so an invited user
 * is created like any other: OIDC redirects with the invite as `redirectTo` and
 * the email as `login_hint`; OSS shows the built-in forms with the email pinned.
 * Acceptance is always one explicit, session-bound POST ("Rejoindre {org}"),
 * the consent + email-mismatch chokepoint.
 */
export function InviteAcceptPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, logout } = useAuth();
  // The verification link of a signup from this page lands back here (`?error=` on failure).
  const verificationLinkFailed = hasVerificationLinkError(useLocation().search);

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [mode, setMode] = useState<"register" | "login">("register");

  const oidc = isHostedAuthEnabled();

  useEffect(() => {
    if (!token) return;
    client
      .GET("/invite/{token}/info", { params: { path: { token } } })
      .then(({ data }) => {
        // Non-2xx throws via the client middleware, so `data` is defined here.
        setInfo(data!);
        setMode(data!.is_new_user ? "register" : "login");
        setLoading(false);
      })
      .catch((err: unknown) => {
        const code = err instanceof ApiError ? err.code : null;
        setServerError(t(inviteErrorKey(code, "invite.invalid")));
        setLoading(false);
      });
  }, [token, t]);

  // OIDC delegation: unlike routes wrapped by `HostedAuthGate`, the starter and
  // login-hint depend on async data, so the hook is driven directly. Acceptance
  // happens on return, in the authed branch.
  useHostedAuthRedirect({
    enabled: !!info && !user && !!token,
    starter: info?.is_new_user ? "signup" : "login",
    redirectTo: token ? `/invite/${token}` : undefined,
    loginHint: info?.email,
    onError: () => setServerError(t("invite.error")),
  });

  const postAccept = useCallback(async () => {
    // Returns the joined org resource; non-2xx throws ApiError via the middleware.
    const { data } = await client.POST("/invite/{token}/accept", {
      params: { path: { token: token ?? "" } },
    });
    // Refetch orgs so the new org is in the cache BEFORE setId triggers useAutoSelect.
    await queryClient.invalidateQueries({ queryKey: orgKeys.all });
    if (data?.id) {
      orgStore.getState().setId(data.id);
    }
    // An existing member keeps their role, whatever the invitation offered.
    if (data && !data.created) {
      toast.info(t("invite.roleUnchanged", { role: t(roleI18nKey(data.role)) }));
    }
    navigate("/");
  }, [token, navigate, queryClient, t]);

  if (loading) {
    return (
      <AuthLayout>
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      </AuthLayout>
    );
  }

  if (serverError && !info) {
    return (
      <AuthLayout>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-xl font-bold">
              <span>App</span>strate
            </h1>
          </div>
          <FieldError className="text-center">{serverError}</FieldError>
          <Button className="w-full" onClick={() => navigate("/")}>
            {t("invite.goHome")}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (!info) return null;

  const inviteBanner = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-xl font-bold">
          <span>App</span>strate
        </h1>
        <p className="text-muted-foreground text-center text-sm">
          {t("invite.description", {
            inviter: info.inviter_name,
            org: info.org_name,
          })}
        </p>
      </div>
      <div className="bg-muted/50 rounded-lg border p-4">
        <div className="text-muted-foreground text-xs">{t("login.email")}</div>
        <div className="text-sm font-medium">{info.email}</div>
        <div className="text-muted-foreground mt-2 text-xs">{t("roles.colRole")}</div>
        <div className="text-sm font-medium">{t(roleI18nKey(info.role))}</div>
      </div>
    </div>
  );

  // Authenticated: the explicit accept step (consent + email-mismatch guard).
  if (user) {
    const emailMatches = user.email.toLowerCase() === info.email.toLowerCase();

    if (!emailMatches) {
      return (
        <AuthLayout>
          <div className="flex flex-col gap-6">
            {inviteBanner}
            <FieldError className="text-center">
              {t("invite.emailMismatch", {
                userEmail: user.email,
                inviteEmail: info.email,
              })}
            </FieldError>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => void logout(token ? `/invite/${token}` : undefined)}
            >
              {t("invite.logoutAndRetry")}
            </Button>
          </div>
        </AuthLayout>
      );
    }

    const handleAcceptAuthenticated = async () => {
      setAccepting(true);
      setServerError(null);
      try {
        await postAccept();
      } catch (err) {
        const code = err instanceof ApiError ? err.code : null;
        setServerError(t(inviteErrorKey(code, "invite.error")));
        setAccepting(false);
      }
    };

    return (
      <AuthLayout>
        <div className="flex flex-col gap-6">
          {inviteBanner}
          <FieldError>{serverError}</FieldError>
          <PendingButton className="w-full" onClick={handleAcceptAuthenticated} pending={accepting}>
            {t("invite.joinOrg", { org: info.org_name })}
          </PendingButton>
        </div>
      </AuthLayout>
    );
  }

  // Unauthenticated + OIDC: the effect above is redirecting; spinner unless it failed.
  if (oidc) {
    if (serverError) {
      return (
        <AuthLayout>
          <div className="flex flex-col gap-6">
            {inviteBanner}
            <FieldError className="text-center">{serverError}</FieldError>
            <Button className="w-full" onClick={() => navigate("/")}>
              {t("invite.goHome")}
            </Button>
          </div>
        </AuthLayout>
      );
    }
    return (
      <AuthLayout>
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      </AuthLayout>
    );
  }

  // Unauthenticated + OSS: standard signup/login, email pinned; on success this
  // re-renders into the authenticated branch above.
  const switchToLogin = (
    <span className="text-muted-foreground text-center text-sm">
      {t("invite.hasAccount")}{" "}
      <AuthLink
        onClick={() => {
          setServerError(null);
          setMode("login");
        }}
      >
        {t("login.login")}
      </AuthLink>
    </span>
  );

  const switchToRegister = (
    <span className="text-muted-foreground text-center text-sm">
      {t("login.noAccount")}{" "}
      <AuthLink
        onClick={() => {
          setServerError(null);
          setMode("register");
        }}
      >
        {t("login.signup")}
      </AuthLink>
    </span>
  );

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        {inviteBanner}
        {verificationLinkFailed && (
          <FieldError>{t("preferences.verificationLinkExpired")}</FieldError>
        )}
        <FieldError>{serverError}</FieldError>
        {mode === "register" ? (
          <RegisterForm
            fixedEmail={info.email}
            header={null}
            footer={null}
            switchAuthSlot={switchToLogin}
            socialCallbackURL={`/invite/${token}`}
            redirectAfterSignup={`/invite/${token}`}
          />
        ) : (
          <LoginForm
            fixedEmail={info.email}
            header={null}
            footer={null}
            switchAuthSlot={switchToRegister}
            callbackURL={`/invite/${token}`}
          />
        )}
      </div>
    </AuthLayout>
  );
}
