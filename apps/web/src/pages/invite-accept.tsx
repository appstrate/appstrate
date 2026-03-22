import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { refreshAuth } from "../hooks/use-auth";
import { orgStore } from "../stores/org-store";
import { Spinner } from "../components/spinner";
import { AuthLayout } from "../components/auth-layout";

interface InviteInfo {
  email: string;
  orgName: string;
  role: string;
  inviterName: string;
  expiresAt: string;
  isNewUser: boolean;
}

interface InviteFormData {
  displayName: string;
  password: string;
  confirmPassword: string;
}

export function InviteAcceptPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    trigger,
    getValues,
    control,
    formState: { errors },
  } = useForm<InviteFormData>({
    defaultValues: { displayName: "", password: "", confirmPassword: "" },
    mode: "onBlur",
  });

  const passwordValue = useWatch({ control, name: "password" });

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

  const handleAccept = async () => {
    if (!token) return;

    if (info?.isNewUser) {
      const valid = await trigger(["password", "confirmPassword"]);
      if (!valid) return;
    }

    setAccepting(true);
    setServerError(null);

    try {
      const body: Record<string, string> = {};
      if (info?.isNewUser) {
        const values = getValues();
        body.password = values.password;
        if (values.displayName.trim()) body.displayName = values.displayName.trim();
      }

      const res = await fetch(`/invite/${token}/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Erreur");
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
      setServerError(err instanceof Error ? err.message : t("invite.error"));
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

  if (serverError && !info) {
    return (
      <AuthLayout>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-xl font-bold">
              <span>App</span>strate
            </h1>
          </div>
          <p className="text-sm text-destructive text-center">{serverError}</p>
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
                {...register("displayName")}
                placeholder={t("login.namePlaceholder")}
                autoComplete="name"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="password">{t("login.password")}</Label>
              <Input
                id="password"
                type="password"
                {...register("password", {
                  required: t("validation.required", { ns: "common" }),
                  minLength: {
                    value: 6,
                    message: t("validation.minLength", { ns: "common", min: 6 }),
                  },
                })}
                placeholder="••••••••"
                minLength={6}
                autoComplete="new-password"
                aria-invalid={errors.password ? true : undefined}
                className={cn(errors.password && "border-destructive")}
              />
              {errors.password && (
                <div className="text-sm text-destructive">{errors.password.message}</div>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="confirmPassword">{t("preferences.confirmPassword")}</Label>
              <Input
                id="confirmPassword"
                type="password"
                {...register("confirmPassword", {
                  validate: (v) =>
                    v === passwordValue || t("validation.passwordMismatch", { ns: "common" }),
                })}
                placeholder="••••••••"
                minLength={6}
                autoComplete="new-password"
                aria-invalid={errors.confirmPassword ? true : undefined}
                className={cn(errors.confirmPassword && "border-destructive")}
              />
              {errors.confirmPassword && (
                <div className="text-sm text-destructive">{errors.confirmPassword.message}</div>
              )}
            </div>
          </div>
        )}

        {serverError && <p className="text-sm text-destructive">{serverError}</p>}

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
