import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTheme } from "../hooks/use-theme";
import { useAuth } from "../hooks/use-auth";
import { useFormErrors } from "../hooks/use-form-errors";

export function LoginPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { resolvedTheme } = useTheme();
  const { login, signup } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const rules = useMemo(
    () => ({
      email: (v: string) => {
        if (!v.trim()) return t("validation.required", { ns: "common" });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
          return t("validation.emailFormat", { ns: "common" });
        return undefined;
      },
      password: (v: string) => {
        if (!v) return t("validation.required", { ns: "common" });
        if (v.length < 6) return t("validation.minLength", { ns: "common", min: 6 });
        return undefined;
      },
      displayName: (v: string) => {
        if (mode === "signup" && !v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
    }),
    [t, mode],
  );

  const { errors, onBlur, validateAll, clearErrors, clearField } = useFormErrors(rules);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setServerError(null);

    if (!validateAll({ email, password, displayName })) return;

    setLoading(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await signup(email, password, displayName || undefined);
      }
    } catch (err) {
      setServerError(err instanceof Error ? err.message : t("login.error"));
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (newMode: "login" | "signup") => {
    setMode(newMode);
    setServerError(null);
    clearErrors();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-lg">
        <div className="flex justify-center mb-4">
          <img
            src={resolvedTheme === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
            alt="Appstrate"
            className="h-8"
          />
        </div>
        <form onSubmit={handleSubmit}>
          {mode === "signup" && (
            <div className="space-y-2">
              <Label htmlFor="displayName">{t("login.name")}</Label>
              <Input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  clearField("displayName");
                }}
                onBlur={() => onBlur("displayName", displayName)}
                placeholder={t("login.namePlaceholder")}
                autoComplete="name"
                aria-invalid={errors.displayName ? true : undefined}
                className={cn(errors.displayName && "border-destructive")}
              />
              {errors.displayName && (
                <div className="text-sm text-destructive">{errors.displayName}</div>
              )}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">{t("login.email")}</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearField("email");
              }}
              onBlur={() => onBlur("email", email)}
              placeholder="email@example.com"
              autoComplete="email"
              aria-invalid={errors.email ? true : undefined}
              className={cn(errors.email && "border-destructive")}
            />
            {errors.email && <div className="text-sm text-destructive">{errors.email}</div>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t("login.password")}</Label>
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
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              aria-invalid={errors.password ? true : undefined}
              className={cn(errors.password && "border-destructive")}
            />
            {errors.password && <div className="text-sm text-destructive">{errors.password}</div>}
          </div>
          {serverError && <p className="text-sm text-destructive">{serverError}</p>}
          <Button className="w-full mt-4" type="submit" disabled={loading}>
            {loading ? t("loading") : mode === "login" ? t("login.login") : t("login.signup")}
          </Button>
        </form>
        <p className="text-center text-sm text-muted-foreground mt-4">
          {mode === "login" ? (
            <>
              {t("login.noAccount")}{" "}
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-sm"
                onClick={() => switchMode("signup")}
              >
                {t("login.signup")}
              </Button>
            </>
          ) : (
            <>
              {t("login.hasAccount")}{" "}
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-sm"
                onClick={() => switchMode("login")}
              >
                {t("login.login")}
              </Button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
