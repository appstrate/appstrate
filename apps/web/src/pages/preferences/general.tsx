// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { useUpdateDisplayName } from "../../hooks/use-profile";
import { useAuth, refreshAuth, EmailChangeError } from "../../hooks/use-auth";
import { useAppConfig } from "../../hooks/use-app-config";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { Modal } from "../../components/modal";
import { Spinner } from "../../components/spinner";
import { SettingsGroup, SettingRow } from "../../components/settings/setting-row";
import { InlineTextSetting } from "../../components/settings/inline-text-setting";
import { TOOLBAR_ACTION } from "../../lib/toolbar-button";

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

/**
 * The email, as a row whose control opens a dialog.
 *
 * This is the pattern's documented EXCEPTION and it earns it: changing an email
 * is not a one-word edit that can commit on blur. It sends a verification
 * message to the address typed, and a blur on a typo would send it to a
 * stranger. So the control is a button that opens a confirm-shaped surface,
 * which is what the row pattern says a consequential change looks like.
 */
function EmailRow() {
  const { t } = useTranslation(["settings", "common"]);
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  return (
    <>
      <SettingRow
        label={t("preferences.email")}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {user?.email}
            <EmailVerificationBadge />
          </span>
        }
      >
        <Button variant="outline" className={TOOLBAR_ACTION} onClick={() => setOpen(true)}>
          {t("preferences.changeEmail")}
        </Button>
      </SettingRow>
      {open && <EmailChangeModal onClose={() => setOpen(false)} />}
    </>
  );
}

function EmailChangeModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const { user, changeEmail } = useAuth();
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
      await changeEmail(data.newEmail.trim());
      reset();
      if (features.smtp) {
        setVerificationPendingEmail(data.newEmail.trim());
      } else {
        setSuccess(t("preferences.emailChanged"));
        await refreshAuth();
      }
    } catch (err) {
      if (err instanceof EmailChangeError && err.conflict) {
        setError("root", { message: t("preferences.emailConflict") });
      } else {
        const message = err instanceof Error && err.message ? err.message : t("login.error");
        setError("root", { message });
      }
    }
  };

  return (
    <Modal open onClose={onClose} title={t("preferences.changeEmail")}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-1">
        <div className="space-y-2">
          <Label>{t("preferences.newEmail")}</Label>
          <Input type="email" autoFocus {...register("newEmail")} placeholder={user?.email ?? ""} />
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
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          {/* A dialog's confirm keeps its surface: it is the deed the dialog
              was opened for, and the bar rule is about a bar. */}
          <Button type="submit" disabled={!canSubmit}>
            {isSubmitting ? t("preferences.changingEmail") : t("preferences.changeEmail")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The display name, as a setting rather than a form.
 *
 * "The control IS the setting": a name is a one-word change, and a Save button
 * put two clicks and a mode change in front of it. It commits on blur or Enter
 * and reverts on Escape, like the organisation's name and the workspace's.
 */
function DisplayNameRow() {
  const { t } = useTranslation(["settings", "common"]);
  const { profile } = useAuth();
  const updateDisplayName = useUpdateDisplayName();

  return (
    <SettingRow label={t("preferences.displayName")}>
      <InlineTextSetting
        value={profile?.displayName ?? ""}
        disabled={updateDisplayName.isPending}
        aria-label={t("preferences.displayName")}
        className="w-64"
        onCommit={(name) => {
          const next = name.trim();
          if (!next) return;
          updateDisplayName.mutate({ body: { displayName: next } });
        }}
      />
      {updateDisplayName.isPending && <Spinner />}
    </SettingRow>
  );
}

export function PreferencesGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <SettingsGroup title={t("preferences.account")}>
      <DisplayNameRow />
      <EmailRow />
    </SettingsGroup>
  );
}
