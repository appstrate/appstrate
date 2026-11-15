// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FormModal } from "./form-modal";
import { Modal } from "./modal";
import { FormItem } from "@/components/app-ui/form-item";
import { SocialSignInButton } from "./social-sign-in-button";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { useAuth } from "../hooks/use-auth";
import type { ReauthMethod } from "../lib/reauth-methods";
import { errorMessage } from "../lib/mutation-error";

interface ReauthModalProps {
  open: boolean;
  onClose: () => void;
  methods: ReauthMethod[];
  /** Retry of the pending fresh-gated action, run once the new session lands. */
  onReauthenticated: () => Promise<void>;
}

export function ReauthModal({ open, onClose, methods, onReauthenticated }: ReauthModalProps) {
  const { t } = useTranslation("settings");
  const { user, login, logout } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // State reset lives in the close handler (not a useEffect) — the React
  // Compiler lint bans set-state-in-effect on `open`.
  const handleClose = () => {
    setPassword("");
    setError("");
    setSubmitting(false);
    onClose();
  };

  const passwordMethod = methods.find((m) => m.kind === "password");
  const socialMethods = methods.filter((m) => m.kind === "social");

  const onPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !user?.email) return;
    setSubmitting(true);
    setError("");
    try {
      await login(user.email, password);
      await onReauthenticated();
      handleClose();
    } catch (err: unknown) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const social = socialMethods.map((method) => (
    <SocialSignInButton
      key={method.provider}
      provider={method.provider}
      callbackURL="/preferences"
      disabled={submitting}
    />
  ));
  const description = (
    <p className="text-muted-foreground text-sm">{t("preferences.reauthDescription")}</p>
  );

  if (!passwordMethod) {
    return (
      <Modal
        onClose={handleClose}
        title={t("preferences.reauthTitle")}
        actions={
          methods.length === 0 ? (
            <Button onClick={() => logout("/login")}>{t("login.login")}</Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-4">
          {description}
          {methods.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("preferences.reauthFallback")}</p>
          ) : (
            social
          )}
        </div>
      </Modal>
    );
  }

  return (
    <FormModal
      onClose={handleClose}
      title={t("preferences.reauthTitle")}
      onSubmit={onPasswordSubmit}
      isPending={submitting}
      error={error || null}
      submitLabel={t("common:btn.confirm")}
    >
      {description}
      <FormItem id="reauth-password" label={t("common:claim.passwordLabel")}>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus
        />
      </FormItem>
      {social}
    </FormModal>
  );
}
