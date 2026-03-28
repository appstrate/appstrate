import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "../components/auth-layout";
import { AuthSuccessState } from "../components/auth-success-state";
import { authClient } from "../lib/auth-client";

export function MagicLinkPage() {
  const { t } = useTranslation(["settings", "common"]);
  const location = useLocation();
  const prefillEmail = (location.state as { email?: string })?.email ?? "";

  const [email, setEmail] = useState(prefillEmail);
  const [state, setState] = useState<"form" | "submitting" | "sent">("form");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setState("submitting");
    setError(null);
    try {
      await authClient.signIn.magicLink({ email: email.trim(), callbackURL: "/" });
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
          <p className="text-center text-sm text-muted-foreground">{t("magicLink.description")}</p>
        </div>
        <form onSubmit={handleSubmit} className="mx-auto w-full max-w-sm flex flex-col gap-4">
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
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={state === "submitting"}>
            {state === "submitting" ? t("loading") : t("magicLink.submit")}
          </Button>
        </form>
        <Link
          to="/login"
          className="text-center text-sm text-muted-foreground underline underline-offset-4 hover:text-primary"
        >
          {t("magicLink.backToLogin")}
        </Link>
      </div>
    </AuthLayout>
  );
}
