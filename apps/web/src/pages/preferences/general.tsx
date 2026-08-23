// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateDisplayName } from "../../hooks/use-profile";
import { useAuth, refreshAuth, EmailChangeError } from "../../hooks/use-auth";
import { useAppConfig } from "../../hooks/use-app-config";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { Spinner } from "../../components/spinner";
import { SettingsGroup, SettingRow } from "../../components/settings/setting-row";
import { InlineTextSetting } from "../../components/settings/inline-text-setting";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";

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

function EmailRow() {
  const { t } = useTranslation(["settings", "common"]);
  const { user, changeEmail } = useAuth();
  const { features } = useAppConfig();
  const [isChanging, setIsChanging] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);
  const email = user?.email ?? "";

  const change = async (next: string) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
      setResetVersion((version) => version + 1);
      return;
    }
    setIsChanging(true);
    try {
      await changeEmail(next);
      if (features.smtp) {
        toast.success(t("preferences.emailChangeVerificationSent", { email: next }));
      } else {
        await refreshAuth();
        toast.success(t("preferences.emailChanged"));
      }
      // SMTP keeps the account's current address until the link is verified.
      // Remount the uncontrolled field so it tells that truth after success.
      setResetVersion((version) => version + 1);
    } catch (err) {
      if (err instanceof EmailChangeError && err.conflict) {
        toast.error(t("preferences.emailConflict"));
      } else {
        const message = err instanceof Error && err.message ? err.message : t("login.error");
        toast.error(message);
      }
    } finally {
      setIsChanging(false);
    }
  };

  return (
    <SettingRow
      variant="field"
      label={t("preferences.email")}
      description={<EmailVerificationBadge />}
      status={isChanging && <Spinner />}
    >
      <InlineTextSetting
        key={resetVersion}
        type="email"
        value={email}
        disabled={isChanging}
        aria-label={t("preferences.email")}
        onCommit={(next) => void change(next)}
      />
    </SettingRow>
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
    <SettingRow
      variant="field"
      label={t("preferences.displayName")}
      status={updateDisplayName.isPending && <Spinner />}
    >
      <InlineTextSetting
        value={profile?.displayName ?? ""}
        disabled={updateDisplayName.isPending}
        aria-label={t("preferences.displayName")}
        onCommit={(name) => {
          const next = name.trim();
          if (!next) return;
          updateDisplayName.mutate(
            { body: { displayName: next } },
            {
              onError: (error) => {
                toast.error(t("error.prefix", { message: getErrorMessage(error) }));
              },
            },
          );
        }}
      />
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
