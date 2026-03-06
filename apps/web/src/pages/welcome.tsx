import { useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { orgStore } from "../stores/org-store";
import { Spinner } from "../components/spinner";
import { useFormErrors } from "../hooks/use-form-errors";

export function WelcomePage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const orgId = searchParams.get("org");

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const rules = useMemo(
    () => ({
      password: (v: string) => {
        if (v && v.length < 8) return t("validation.minLength", { ns: "common", min: 8 });
        return undefined;
      },
      confirmPassword: (v: string) => {
        if (password && v !== password) return t("validation.passwordMismatch", { ns: "common" });
        return undefined;
      },
    }),
    [t, password],
  );

  const { errors, onBlur, validateAll, clearField } = useFormErrors(rules);

  const finishAndRedirect = () => {
    if (orgId) {
      orgStore.getState().setId(orgId);
    }
    navigate("/");
    window.location.reload();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    if (!validateAll({ password, confirmPassword })) return;

    setLoading(true);

    try {
      const body: Record<string, string> = {};
      if (displayName.trim()) body.displayName = displayName.trim();
      if (password) body.password = password;

      if (Object.keys(body).length > 0) {
        const res = await fetch("/api/welcome/setup", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || "Erreur");
        }
      }

      finishAndRedirect();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Erreur");
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-lg">
        <h1 className="text-2xl font-bold text-center mb-2">
          <span>App</span>strate
        </h1>
        <p className="text-center text-sm text-muted-foreground mb-6">{t("welcome.subtitle")}</p>

        <form onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="displayName">{t("welcome.displayName")}</Label>
            <Input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("login.namePlaceholder")}
              autoComplete="name"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">
              {t("welcome.password")}{" "}
              <span className="text-xs text-muted-foreground font-normal">
                ({t("welcome.optional")})
              </span>
            </Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clearField("password");
              }}
              onBlur={() => onBlur("password", password)}
              placeholder="••••••••"
              minLength={8}
              autoComplete="new-password"
              aria-invalid={errors.password ? true : undefined}
              className={cn(errors.password && "border-destructive")}
            />
            {errors.password && <div className="text-sm text-destructive">{errors.password}</div>}
          </div>

          {password && (
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">{t("preferences.confirmPassword")}</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  clearField("confirmPassword");
                }}
                onBlur={() => onBlur("confirmPassword", confirmPassword)}
                placeholder="••••••••"
                minLength={8}
                autoComplete="new-password"
                aria-invalid={errors.confirmPassword ? true : undefined}
                className={cn(errors.confirmPassword && "border-destructive")}
              />
              {errors.confirmPassword && (
                <div className="text-sm text-destructive">{errors.confirmPassword}</div>
              )}
            </div>
          )}

          {serverError && <p className="text-sm text-destructive">{serverError}</p>}

          <Button className="w-full mt-4" type="submit" disabled={loading}>
            {loading ? <Spinner /> : t("welcome.save")}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground mt-4">
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-sm"
            onClick={finishAndRedirect}
          >
            {t("welcome.skip")}
          </Button>
        </p>
      </div>
    </div>
  );
}
