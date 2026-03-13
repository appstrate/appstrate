import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { refreshAuth } from "../hooks/use-auth";
import { orgStore } from "../stores/org-store";
import { Spinner } from "../components/spinner";
import { AuthLayout } from "../components/auth-layout";
import { useFormErrors } from "../hooks/use-form-errors";

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

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  const rules = useMemo(
    () => ({
      password: (v: string) => {
        if (!v) return t("validation.required", { ns: "common" });
        if (v.length < 8) return t("validation.minLength", { ns: "common", min: 8 });
        return undefined;
      },
      confirmPassword: (v: string) => {
        if (v !== password) return t("validation.passwordMismatch", { ns: "common" });
        return undefined;
      },
    }),
    [t, password],
  );

  const { errors, onBlur, validateAll, clearField } = useFormErrors(rules);

  useEffect(() => {
    if (!token) return;
    fetch(`/invite/${token}/info`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "INVITATION_NOT_FOUND");
        }
        return res.json();
      })
      .then((data: InviteInfo) => {
        setInfo(data);
        setLoading(false);
      })
      .catch((err) => {
        const code = err instanceof Error ? err.message : "INVITATION_NOT_FOUND";
        if (code === "INVITATION_EXPIRED") {
          setError(t("invite.expired"));
        } else if (code === "INVITATION_ACCEPTED") {
          setError(t("invite.alreadyAccepted"));
        } else if (code === "INVITATION_CANCELLED") {
          setError(t("invite.cancelled"));
        } else {
          setError(t("invite.invalid"));
        }
        setLoading(false);
      });
  }, [token, t]);

  const handleAccept = async () => {
    if (!token) return;

    if (info?.isNewUser) {
      if (!validateAll({ password, confirmPassword })) return;
    }

    setAccepting(true);
    setError(null);

    try {
      const body: Record<string, string> = {};
      if (info?.isNewUser) {
        body.password = password;
        if (displayName.trim()) body.displayName = displayName.trim();
      }

      const res = await fetch(`/invite/${token}/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Erreur");
      }

      const data = await res.json();

      if (data.orgId) {
        orgStore.getState().setId(data.orgId);
      }
      if (data.isNewUser) {
        await refreshAuth();
      }

      navigate("/");
      if (!data.requiresLogin) {
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("invite.error"));
      setAccepting(false);
    }
  };

  if (loading) {
    return (
      <AuthLayout>
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      </AuthLayout>
    );
  }

  if (error && !info) {
    return (
      <AuthLayout>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-xl font-bold">
              <span>App</span>strate
            </h1>
          </div>
          <p className="text-sm text-destructive text-center">{error}</p>
          <Button className="w-full" onClick={() => navigate("/")}>
            {t("invite.goHome")}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-xl font-bold">
            <span>App</span>strate
          </h1>
          <p className="text-center text-sm text-muted-foreground">
            {t("invite.description", {
              inviter: info?.inviterName,
              org: info?.orgName,
            })}
          </p>
        </div>

        <div className="rounded-lg border bg-muted/50 p-4">
          <div className="text-xs text-muted-foreground">{t("invite.emailLabel")}</div>
          <div className="text-sm font-medium">{info?.email}</div>
          <div className="text-xs text-muted-foreground mt-2">{t("invite.roleLabel")}</div>
          <div className="text-sm font-medium">
            {info?.role === "admin" ? t("orgSettings.roleAdmin") : t("orgSettings.roleMember")}
          </div>
        </div>

        {info?.isNewUser && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {t("invite.createAccount", { org: info.orgName })}
            </p>

            <div className="grid gap-2">
              <Label htmlFor="displayName">{t("welcome.displayName")}</Label>
              <Input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t("login.namePlaceholder")}
                autoComplete="name"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="password">{t("login.password")}</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  clearField("password");
                }}
                onBlur={() => onBlur("password", password)}
                placeholder="••••••••"
                minLength={8}
                autoComplete="new-password"
                aria-invalid={errors.password ? true : undefined}
                className={cn(errors.password && "border-destructive")}
              />
              {errors.password && <div className="text-sm text-destructive">{errors.password}</div>}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="confirmPassword">{t("preferences.confirmPassword")}</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  clearField("confirmPassword");
                }}
                onBlur={() => onBlur("confirmPassword", confirmPassword)}
                placeholder="••••••••"
                minLength={8}
                autoComplete="new-password"
                aria-invalid={errors.confirmPassword ? true : undefined}
                className={cn(errors.confirmPassword && "border-destructive")}
              />
              {errors.confirmPassword && (
                <div className="text-sm text-destructive">{errors.confirmPassword}</div>
              )}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button className="w-full" onClick={handleAccept} disabled={accepting}>
          {accepting ? (
            <Spinner />
          ) : info?.isNewUser ? (
            t("invite.createAndAccept")
          ) : (
            t("invite.accept")
          )}
        </Button>
      </div>
    </AuthLayout>
  );
}
