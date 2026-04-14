// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUpdateDisplayName } from "../../hooks/use-profile";
import { useAuth, refreshAuth } from "../../hooks/use-auth";
import { useAppConfig } from "../../hooks/use-app-config";
import { authClient } from "../../lib/auth-client";
import { CheckCircle2, AlertCircle } from "lucide-react";

function EmailVerificationBadge() {
  const { t } = useTranslation(["settings", "common"]);
  const { user, resendVerificationEmail } = useAuth();
  const { features } = useAppConfig();
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  if (!features.smtp || !user) return null;

  if (user.emailVerified) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 size={14} />
        <span>{t("preferences.emailVerified")}</span>
      </div>
    );
  }

  const handleResend = async () => {
    setResendState("sending");
    try {
      await resendVerificationEmail(user.email);
      setResendState("sent");
      setTimeout(() => setResendState("idle"), 3000);
    } catch {
      setResendState("idle");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
        <AlertCircle size={14} />
        <span>{t("preferences.emailNotVerified")}</span>
      </div>
      <button
        type="button"
        onClick={handleResend}
        disabled={resendState !== "idle"}
        className="text-primary text-xs underline underline-offset-2 hover:no-underline disabled:no-underline disabled:opacity-50"
      >
        {resendState === "sending"
          ? t("preferences.resendingVerification")
          : resendState === "sent"
            ? t("preferences.verificationResent")
            : t("preferences.resendVerification")}
      </button>
    </div>
  );
}

function EmailChangeForm() {
  const { t } = useTranslation(["settings", "common"]);
  const { user } = useAuth();
  const { features } = useAppConfig();
  const [success, setSuccess] = useState("");
  const [verificationPendingEmail, setVerificationPendingEmail] = useState("");

  const {
    register,
    handleSubmit,
    setError,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm<{ newEmail: string }>({
    defaultValues: { newEmail: "" },
  });

  const newEmailValue = useWatch({ control, name: "newEmail" });
  const isDirty = newEmailValue.trim() !== "" && newEmailValue.trim() !== user?.email;
  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmailValue.trim());
  const canSubmit = isDirty && isValidEmail && !isSubmitting;

  const onSubmit = async (data: { newEmail: string }) => {
    setSuccess("");
    setVerificationPendingEmail("");
    try {
      const result = await authClient.changeEmail({ newEmail: data.newEmail.trim() });
      if (result.error) {
        if (result.error.status === 409) {
          setError("root", { message: t("preferences.emailConflict") });
        } else {
          setError("root", { message: result.error.message || t("login.error") });
        }
      } else {
        reset();
        if (features.smtp) {
          setVerificationPendingEmail(data.newEmail.trim());
        } else {
          setSuccess(t("preferences.emailChanged"));
          await refreshAuth();
        }
      }
    } catch {
      setError("root", { message: t("login.error") });
    }
  };

  return (
    <div className="border-border bg-card mb-4 rounded-lg border p-5">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-1">
        <div className="space-y-2">
          <Label>{t("preferences.email")}</Label>
          <Input type="email" value={user?.email ?? ""} disabled />
          <EmailVerificationBadge />
        </div>
        <div className="space-y-2">
          <Label>{t("preferences.newEmail")}</Label>
          <Input type="email" {...register("newEmail")} placeholder={user?.email ?? ""} />
        </div>
        {errors.root && <div className="text-destructive text-sm">{errors.root.message}</div>}
        {success && <div className="text-success text-sm">{success}</div>}
        {verificationPendingEmail && (
          <div className="text-muted-foreground bg-muted rounded-md px-3 py-2 text-sm">
            <Trans
              ns="settings"
              i18nKey="preferences.emailChangeVerificationSent"
              values={{ email: verificationPendingEmail }}
              components={{ strong: <strong /> }}
            />
          </div>
        )}
        <Button type="submit" disabled={!canSubmit}>
          {isSubmitting ? t("preferences.changingEmail") : t("preferences.changeEmail")}
        </Button>
      </form>
    </div>
  );
}

function DisplayNameForm() {
  const { t } = useTranslation(["settings", "common"]);
  const { profile } = useAuth();
  const updateDisplayName = useUpdateDisplayName();
  const [success, setSuccess] = useState("");

  const { register, handleSubmit, control } = useForm<{ name: string }>({
    defaultValues: { name: profile?.displayName ?? "" },
  });

  const nameValue = useWatch({ control, name: "name" });
  const isDirty = nameValue.trim() !== (profile?.displayName ?? "");
  const canSubmit = nameValue.trim().length > 0 && isDirty && !updateDisplayName.isPending;

  const onSubmit = (data: { name: string }) => {
    setSuccess("");
    updateDisplayName.mutate(data.name.trim(), {
      onSuccess: () => {
        setSuccess(t("preferences.displayNameChanged"));
      },
    });
  };

  return (
    <div className="border-border bg-card mb-4 rounded-lg border p-5">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-1">
        <div className="space-y-2">
          <Label>{t("preferences.displayName")}</Label>
          <Input
            type="text"
            {...register("name")}
            onChange={(e) => {
              register("name").onChange(e);
              setSuccess("");
            }}
            maxLength={100}
          />
        </div>
        {success && <div className="text-success text-sm">{success}</div>}
        <Button type="submit" disabled={!canSubmit}>
          {updateDisplayName.isPending
            ? t("preferences.savingDisplayName")
            : t("preferences.saveDisplayName")}
        </Button>
      </form>
    </div>
  );
}

export function PreferencesGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <>
      <div className="text-muted-foreground mb-4 text-sm font-medium">
        {t("preferences.account")}
      </div>
      <EmailChangeForm />
      <DisplayNameForm />
    </>
  );
}
