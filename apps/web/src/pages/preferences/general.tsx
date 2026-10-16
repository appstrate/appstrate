// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useUpdateDisplayName } from "../../hooks/use-profile";
import { useLocation } from "react-router-dom";
import { useAuth, EmailChangeError } from "../../hooks/use-auth";
import { emailChangeLanding } from "../../lib/auth-flow";
import { useAppConfig } from "../../hooks/use-app-config";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { SaveFeedback } from "../../components/settings/save-feedback";
import { SettingsGroup, SettingRow } from "../../components/settings/setting-row";
import { InlineTextSetting } from "../../components/settings/inline-text-setting";
import { Input } from "@appstrate/ui/components/input";
import { Button } from "@appstrate/ui/components/button";
import { FieldError } from "@appstrate/ui/components/field";
import { toast } from "sonner";
import { toastError } from "../../lib/mutation-error";

function EmailVerificationBadge() {
  const { t } = useTranslation(["settings", "common"]);
  const { user, resendVerificationEmail } = useAuth();
  const { features } = useAppConfig();
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  if (!features.smtp || !user) return null;

  if (user.emailVerified) {
    return (
      <div className="text-success flex items-center gap-1.5 text-xs">
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
      <div className="text-warning flex items-center gap-1.5 text-xs">
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
          ? t("verifyEmail.resending")
          : resendState === "sent"
            ? t("preferences.verificationResent")
            : t("preferences.resendVerification")}
      </button>
    </div>
  );
}

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The account's address and the field to change it. The login address changes only on the
 * explicit button, never on blur: without SMTP the change applies at once.
 */
export function EmailChangeField({
  email,
  draft,
  pending,
  onDraftChange,
  onSubmit,
}: {
  email: string;
  /** What is typed, `null` while the field shows the current address. */
  draft: string | null;
  pending: boolean;
  onDraftChange: (next: string) => void;
  onSubmit: (next: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const next = (draft ?? email).trim();
  const dirty = next !== "" && next !== email;
  const invalid = dirty && !EMAIL_FORMAT.test(next);

  return (
    <div className="flex w-full flex-col gap-1.5">
      <form
        className="flex w-full items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !invalid) onSubmit(next);
        }}
      >
        <Input
          type="email"
          value={draft ?? email}
          disabled={pending}
          aria-label={t("common:claim.emailLabel")}
          aria-invalid={invalid}
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <Button type="submit" disabled={!dirty || invalid || pending}>
          {t("preferences.changeEmail")}
        </Button>
      </form>
      {invalid && <FieldError>{t("common:validation.emailFormat")}</FieldError>}
    </div>
  );
}

function EmailRow() {
  const { t } = useTranslation(["settings", "common"]);
  const { user, changeEmail } = useAuth();
  const [isChanging, setIsChanging] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [changedHere, setChangedHere] = useState(false);
  const { search } = useLocation();
  const email = user?.email ?? "";
  // What the email-change link that led here did, until the row is used again.
  const landing = user && !changedHere ? emailChangeLanding(search) : null;

  const change = async (next: string) => {
    setChangedHere(true);
    setIsChanging(true);
    try {
      const outcome = await changeEmail(next);
      if (outcome === "confirmation_sent") {
        toast.success(
          <Trans
            ns="settings"
            i18nKey="preferences.emailChangeConfirmationSent"
            values={{ email: next }}
            components={{ strong: <strong /> }}
          />,
        );
      } else {
        toast.success(t("preferences.emailChanged"));
      }
      // SMTP keeps the account's current address until the change is approved.
      setDraft(null);
    } catch (err) {
      if (err instanceof EmailChangeError) {
        toast.error(t("preferences.emailConflict"));
      } else {
        toastError(err);
      }
    } finally {
      setIsChanging(false);
    }
  };

  return (
    <SettingRow
      variant="field"
      label={t("common:claim.emailLabel")}
      description={
        <>
          <EmailVerificationBadge />
          {landing === "failed" && (
            <span className="text-destructive block text-xs">
              {t("preferences.verificationLinkExpired")}
            </span>
          )}
          {landing === "refused" && (
            <span className="text-destructive block text-xs">
              {t("common:apiError.email_change_refused")}
            </span>
          )}
          {landing === "accepted" && (
            <span className="text-muted-foreground block text-xs">
              {t("preferences.emailChangeLinkAccepted")}
            </span>
          )}
        </>
      }
      status={<SaveFeedback pending={isChanging} success={false} error={false} />}
    >
      <EmailChangeField
        email={email}
        draft={draft}
        pending={isChanging}
        onDraftChange={setDraft}
        onSubmit={(next) => void change(next)}
      />
    </SettingRow>
  );
}

/**
 * The display name, as a setting rather than a form.
 *
 * "The control IS the setting": a name is a one-word change, and a Save button
 * put two clicks and a mode change in front of it. It commits on blur or Enter
 * and reverts on Escape, like the organization's name and the workspace's.
 */
function DisplayNameRow() {
  const { t } = useTranslation(["settings", "common"]);
  const { profile } = useAuth();
  const updateDisplayName = useUpdateDisplayName();

  return (
    <SettingRow
      variant="field"
      label={t("preferences.displayName")}
      status={
        <SaveFeedback
          pending={updateDisplayName.isPending}
          success={updateDisplayName.isSuccess}
          error={updateDisplayName.isError}
        />
      }
    >
      <InlineTextSetting
        value={profile?.displayName ?? ""}
        disabled={updateDisplayName.isPending}
        maxLength={100}
        aria-label={t("preferences.displayName")}
        onCommit={(displayName) => updateDisplayName.mutateAsync({ body: { displayName } })}
      />
    </SettingRow>
  );
}

export function PreferencesGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <SettingsGroup title={t("preferences.sectionAccount")}>
      <DisplayNameRow />
      <EmailRow />
    </SettingsGroup>
  );
}
