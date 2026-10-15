// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { SocialSignInButton } from "./social-sign-in-button";
import { Button } from "@appstrate/ui/components/button";
import { FieldError } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
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

  return (
    <Modal open={open} onClose={handleClose} title={t("preferences.reauthTitle")}>
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">{t("preferences.reauthDescription")}</p>

        {methods.length === 0 ? (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">{t("preferences.reauthFallback")}</p>
            <Button onClick={() => logout("/login")}>{t("login.login")}</Button>
          </div>
        ) : (
          <div className="space-y-4">
            {passwordMethod && (
              <form onSubmit={onPasswordSubmit} className="space-y-3">
                <div className="space-y-2">
                  <Label>{t("preferences.reauthPassword")}</Label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    autoFocus
                  />
                </div>
                <FieldError>{error}</FieldError>
                <Button type="submit" pending={submitting}>
                  {t("preferences.reauthConfirm")}
                </Button>
              </form>
            )}

            {socialMethods.map((method) => (
              <SocialSignInButton
                key={method.provider}
                provider={method.provider}
                callbackURL="/preferences"
                disabled={submitting}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
