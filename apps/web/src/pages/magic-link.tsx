// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { AuthLayout } from "../components/auth-layout";
import { AuthSuccessState } from "../components/auth-success-state";
import { useAuth } from "../hooks/use-auth";

export function MagicLinkPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { startMagicLink } = useAuth();
  const location = useLocation();
  const prefillEmail = (location.state as { email?: string })?.email ?? "";
  // A spent or expired link redirects here with `?error=` (see `startMagicLink`).
  const linkFailed = useSearchParams()[0].has("error");

  const [email, setEmail] = useState(prefillEmail);
  const [state, setState] = useState<"form" | "submitting" | "sent">("form");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setState("submitting");
    setError(null);
    try {
      await startMagicLink(email.trim());
      setState("sent");
    } catch {
      setError(t("magicLink.error"));
      setState("form");
    }
  };

  if (state === "sent") {
    return (
      <AuthLayout>
        <AuthSuccessState
          icon={Mail}
          title={t("magicLink.sentTitle")}
          description={t("magicLink.sentDescription")}
          backTo="/login"
          backLabel={t("magicLink.backToLogin")}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-xl font-bold">{t("magicLink.title")}</h1>
          <p className="text-muted-foreground text-center text-sm">{t("magicLink.description")}</p>
        </div>
        <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-sm flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="email">{t("login.email")}</Label>
            <Input
              id="email"
              type="email"
              placeholder="email@example.com"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          {linkFailed && !error && (
            <p className="text-destructive text-sm">{t("magicLink.linkInvalid")}</p>
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button type="submit" className="w-full" disabled={state === "submitting"}>
            {state === "submitting" ? t("loading") : t("magicLink.submit")}
          </Button>
        </form>
        <Link
          to="/login"
          className="text-muted-foreground hover:text-primary text-center text-sm underline underline-offset-4"
        >
          {t("magicLink.backToLogin")}
        </Link>
      </div>
    </AuthLayout>
  );
}
