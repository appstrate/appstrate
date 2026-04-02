// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { refreshAuth, useAuth } from "../hooks/use-auth";
import { orgStore } from "../stores/org-store";
import { Spinner } from "../components/spinner";
import { AuthLayout } from "../components/auth-layout";
import { RegisterForm } from "../components/register-form";
import { LoginForm } from "../components/login-form";
import { roleI18nKey } from "../hooks/use-permissions";

interface InviteInfo {
  email: string;
  orgName: string;
  role: string;
  inviterName: string;
  expiresAt: string;
  isNewUser: boolean;
}

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

  useEffect(() => {
    if (!token) return;
    fetch(`/invite/${token}/info`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.code || "invitation_not_found");
        }
        return res.json();
      })
      .then((data: InviteInfo) => {
        setInfo(data);
        setMode(data.isNewUser ? "register" : "login");
        setLoading(false);
      })
      .catch((err) => {
        const code = err instanceof Error ? err.message : "invitation_not_found";
        if (code === "invitation_expired") {
          setServerError(t("invite.expired"));
        } else if (code === "invitation_accepted") {
          setServerError(t("invite.alreadyAccepted"));
        } else if (code === "invitation_cancelled") {
          setServerError(t("invite.cancelled"));
        } else {
          setServerError(t("invite.invalid"));
        }
        setLoading(false);
      });
  }, [token, t]);

  /** POST accept + handle success (shared by all accept flows) */
  const postAccept = useCallback(
    async (body: Record<string, string> = {}) => {
      const res = await fetch(`/invite/${token}/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || t("invite.error"));
      }
      const data = await res.json();
      await refreshAuth();
      // Refetch orgs so the new org is in the cache BEFORE setId triggers useAutoSelect
      await queryClient.invalidateQueries({ queryKey: ["orgs"] });
      if (data.orgId) {
        orgStore.getState().setId(data.orgId);
      }
      navigate("/");
    },
    [token, navigate, t, queryClient],
  );

  const handleRegisterAndAccept = useCallback(
    async (formData: { email: string; password: string; displayName: string }) => {
      await postAccept({
        password: formData.password,
        displayName: formData.displayName || undefined,
      } as Record<string, string>);
    },
    [postAccept],
  );

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
            inviter: info.inviterName,
            org: info.orgName,
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

  // Authenticated user: check email match then show accept button
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
            <Button variant="outline" className="w-full" onClick={logout}>
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
        setServerError(err instanceof Error ? err.message : t("invite.error"));
        setAccepting(false);
      }
    };

    return (
      <AuthLayout>
        <div className="flex flex-col gap-6">
          {inviteBanner}
          {serverError && <p className="text-destructive text-sm">{serverError}</p>}
          <Button className="w-full" onClick={handleAcceptAuthenticated} disabled={accepting}>
            {accepting ? <Spinner /> : t("invite.joinOrg", { org: info.orgName })}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  // Unauthenticated: register or login mode
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
            onSubmitOverride={handleRegisterAndAccept}
            header={null}
            footer={null}
            switchAuthSlot={switchToLogin}
            socialCallbackURL={`/invite/${token}`}
          />
        ) : (
          <LoginForm
            fixedEmail={info.email}
            onSuccess={postAccept}
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
