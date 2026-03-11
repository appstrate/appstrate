import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTheme } from "../hooks/use-theme";
import { useAuth } from "../hooks/use-auth";
import { useFormErrors } from "../hooks/use-form-errors";
import { AppleIcon, GoogleIcon } from "./icons";

export function RegisterForm({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  const { t } = useTranslation(["settings", "common"]);
  const { resolvedTheme } = useTheme();
  const { signup } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
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
        if (!v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
    }),
    [t],
  );

  const { errors, onBlur, validateAll, clearField } = useFormErrors(rules);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setServerError(null);

    if (!validateAll({ email, password, displayName })) return;

    setLoading(true);
    try {
      await signup(email, password, displayName || undefined);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : t("login.error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <form onSubmit={handleSubmit}>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-2">
            <Link to="/" className="flex flex-col items-center gap-2 font-medium">
              <img
                src={resolvedTheme === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
                alt="Appstrate"
                className="h-11"
              />
            </Link>
            <div className="text-center text-sm text-muted-foreground">
              {t("login.hasAccount")}{" "}
              <Link to="/login" className="underline underline-offset-4 hover:text-primary">
                {t("login.login")}
              </Link>
            </div>
          </div>
          <div className="mx-auto w-full max-w-sm flex flex-col gap-6">
            <div className="grid gap-4">
              <div className="grid gap-2">
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
              <div className="grid gap-2">
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
              <div className="grid gap-2">
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
                  autoComplete="new-password"
                  aria-invalid={errors.password ? true : undefined}
                  className={cn(errors.password && "border-destructive")}
                />
                {errors.password && (
                  <div className="text-sm text-destructive">{errors.password}</div>
                )}
              </div>
              {serverError && <p className="text-sm text-destructive">{serverError}</p>}
            </div>
            <Button size="lg" className="w-full mt-2" type="submit" disabled={loading}>
              {loading ? t("loading") : t("login.signup")}
            </Button>
            <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t after:border-border">
              <span className="relative z-10 bg-background px-2 text-muted-foreground">
                {t("login.or")}
              </span>
            </div>
          </div>
          <div className="mx-auto w-full max-w-sm sm:max-w-none grid gap-4 sm:grid-cols-2">
            <Button variant="outline" className="w-full text-foreground" type="button">
              <AppleIcon />
              {t("login.continueApple")}
            </Button>
            <Button variant="outline" className="w-full text-foreground" type="button">
              <GoogleIcon />
              {t("login.continueGoogle")}
            </Button>
          </div>
        </div>
      </form>
      <div className="text-balance text-center text-xs text-muted-foreground [&_a]:underline [&_a]:underline-offset-4 hover:[&_a]:text-primary">
        {t("login.termsNotice")} <a href="#">{t("login.termsOfService")}</a> {t("login.and")}{" "}
        <a href="#">{t("login.privacyPolicy")}</a>.
      </div>
    </div>
  );
}
