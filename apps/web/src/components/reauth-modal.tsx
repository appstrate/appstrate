// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Spinner } from "./spinner";
import { GoogleIcon, GitHubIcon } from "./icons";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { useAuth } from "../hooks/use-auth";
import type { ReauthMethod } from "../lib/reauth-methods";

const PROVIDER_LABELS: Record<"google" | "github", string> = {
  google: "Google",
  github: "GitHub",
};

const PROVIDER_ICONS: Record<"google" | "github", typeof GoogleIcon> = {
  google: GoogleIcon,
  github: GitHubIcon,
};

interface ReauthModalProps {
  open: boolean;
  onClose: () => void;
  methods: ReauthMethod[];
  /** Retry of the pending fresh-gated action, run once the new session lands. */
  onReauthenticated: () => Promise<void>;
}

export function ReauthModal({ open, onClose, methods, onReauthenticated }: ReauthModalProps) {
  const { t } = useTranslation("settings");
  const { user, login, signInWithSocial, logout } = useAuth();
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
      setError(err instanceof Error && err.message ? err.message : t("login.error"));
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
                {error && <div className="text-destructive text-sm">{error}</div>}
                <Button type="submit" disabled={submitting}>
                  {submitting ? <Spinner /> : t("preferences.reauthConfirm")}
                </Button>
              </form>
            )}

            {socialMethods.map((method) => {
              const Icon = PROVIDER_ICONS[method.provider];
              return (
                <Button
                  key={method.provider}
                  variant="outline"
                  className="w-full"
                  disabled={submitting}
                  onClick={() => signInWithSocial(method.provider, "/preferences")}
                >
                  <Icon className="h-4 w-4" />
                  {t("preferences.reauthContinueWith", {
                    provider: PROVIDER_LABELS[method.provider],
                  })}
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
