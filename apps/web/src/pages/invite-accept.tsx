// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@appstrate/ui/components/button";
import { ApiError, client, type paths } from "../api/client";
import { refreshAuth, useAuth } from "../hooks/use-auth";
import { useHostedAuthRedirect, isHostedAuthEnabled } from "../hooks/use-hosted-auth-redirect";
import { orgStore } from "../stores/org-store";
import { Spinner } from "../components/spinner";
import { AuthLayout } from "../components/auth-layout";
import { RegisterForm } from "../components/register-form";
import { LoginForm } from "../components/login-form";
import { roleI18nKey } from "../hooks/use-permissions";
import { orgKeys } from "../lib/query-keys";

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
 * Invitation acceptance — a single route (`/invite/:token`) that is, in
 * order: a loader, then an authentication delegator, then an explicit accept.
 *
 * Authentication is never performed inline by this page; it delegates to the
 * platform-standard path so an invited user is created exactly like any other
 * user:
 *   - OIDC instance → redirect into the OIDC login/signup flow, carrying the
 *     invite as `redirectTo` and the invited email as `login_hint` (pinned).
 *   - OSS instance  → the built-in email/password + social forms, email pinned.
 *
 * On return the user is authenticated and lands back here; acceptance is then
 * a single explicit, session-bound POST ("Rejoindre {org}") — the same button
 * for everyone (post-OIDC, post-OSS-login, post-OSS-signup, already-authed).
 * That uniform explicit step is the consent + email-mismatch chokepoint.
 */
export function InviteAcceptPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, logout } = useAuth();

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

  // OIDC delegation: once the invite is loaded and the visitor is not yet
  // authenticated, redirect into the standard OIDC flow through the same
  // `useHostedAuthRedirect` seam every other auth route uses. Unlike the
  // simple routes (wrapped by `HostedAuthGate`), the invite chooses its
  // starter and login-hint from data loaded asynchronously, so it drives the
  // hook directly: the token rides as `redirectTo` (the browser returns here
  // authenticated) and the invited email as `login_hint` (pinned on the hosted
  // page). Acceptance happens on return, in the authed branch.
  useHostedAuthRedirect({
    enabled: !!info && !user && !!token,
    starter: info?.is_new_user ? "signup" : "login",
    redirectTo: token ? `/invite/${token}` : undefined,
    loginHint: info?.email,
    onError: () => setServerError(t("invite.error")),
  });

  /** POST accept (session-bound, no body) + handle success. */
  const postAccept = useCallback(async () => {
    // Non-2xx throws ApiError (RFC 9457 detail) via the client middleware.
    // The accept endpoint returns the joined org resource (same shape as the
    // GET /api/orgs list items).
    const { data } = await client.POST("/invite/{token}/accept", {
      params: { path: { token: token ?? "" } },
    });
    await refreshAuth();
    // Refetch orgs so the new org is in the cache BEFORE setId triggers useAutoSelect.
    await queryClient.invalidateQueries({ queryKey: orgKeys.all });
    if (data?.id) {
      orgStore.getState().setId(data.id);
    }
    navigate("/");
  }, [token, navigate, queryClient]);

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
          <p className="text-destructive text-center text-sm">{serverError}</p>
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
        <div className="text-muted-foreground text-xs">{t("invite.emailLabel")}</div>
        <div className="text-sm font-medium">{info.email}</div>
        <div className="text-muted-foreground mt-2 text-xs">{t("invite.roleLabel")}</div>
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
            <p className="text-destructive text-center text-sm">
              {t("invite.emailMismatch", {
                userEmail: user.email,
                inviteEmail: info.email,
              })}
            </p>
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
          {serverError && <p className="text-destructive text-sm">{serverError}</p>}
          <Button className="w-full" onClick={handleAcceptAuthenticated} disabled={accepting}>
            {accepting ? <Spinner /> : t("invite.joinOrg", { org: info.org_name })}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  // Unauthenticated + OIDC: the delegation effect above is redirecting away.
  // Render a spinner for that brief window — unless the redirect failed, in
  // which case show the error instead of spinning forever.
  if (oidc) {
    if (serverError) {
      return (
        <AuthLayout>
          <div className="flex flex-col gap-6">
            {inviteBanner}
            <p className="text-destructive text-center text-sm">{serverError}</p>
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

  // Unauthenticated + OSS: inline email/password + social forms, email pinned.
  // These run the platform-standard signup/login (no accept coupling). On
  // success the auth context updates and this page re-renders into the
  // authenticated branch above, where the user explicitly accepts.
  const switchToLogin = (
    <span className="text-muted-foreground text-center text-sm">
      {t("invite.hasAccount")}{" "}
      <button
        type="button"
        className="hover:text-primary underline underline-offset-4"
        onClick={() => {
          setServerError(null);
          setMode("login");
        }}
      >
        {t("login.login")}
      </button>
    </span>
  );

  const switchToRegister = (
    <span className="text-muted-foreground text-center text-sm">
      {t("invite.noAccount")}{" "}
      <button
        type="button"
        className="hover:text-primary underline underline-offset-4"
        onClick={() => {
          setServerError(null);
          setMode("register");
        }}
      >
        {t("login.signup")}
      </button>
    </span>
  );

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        {inviteBanner}
        {serverError && <p className="text-destructive text-sm">{serverError}</p>}
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
            onSuccess={refreshAuth}
            header={null}
            footer={null}
            switchAuthSlot={switchToRegister}
            socialCallbackURL={`/invite/${token}`}
          />
        )}
      </div>
    </AuthLayout>
  );
}
