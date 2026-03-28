import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTheme } from "../stores/theme-store";
import { useAuth } from "../hooks/use-auth";
import { useAppConfig } from "../hooks/use-app-config";
import { GoogleSignInButton } from "./google-sign-in-button";
import { GitHubSignInButton } from "./github-sign-in-button";

type RegisterFormData = {
  displayName: string;
  email: string;
  password: string;
};

export function RegisterForm({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  const { t } = useTranslation(["settings", "common"]);
  const { resolvedTheme } = useTheme();
  const { signup } = useAuth();
  const { features } = useAppConfig();
  const navigate = useNavigate();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormData>({
    defaultValues: { displayName: "", email: "", password: "" },
    mode: "onBlur",
  });

  const onSubmit = async (data: RegisterFormData) => {
    try {
      const result = await signup(data.email, data.password, data.displayName.trim() || undefined);
      if (result.emailVerificationRequired) {
        navigate("/verify-email", { state: { email: data.email } });
      }
    } catch (err) {
      setError("root", {
        message: err instanceof Error ? err.message : t("login.error"),
      });
    }
  };

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <form onSubmit={handleSubmit(onSubmit)}>
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
                  placeholder={t("login.namePlaceholder")}
                  autoComplete="name"
                  aria-invalid={errors.displayName ? true : undefined}
                  className={cn(errors.displayName && "border-destructive")}
                  {...register("displayName", {
                    required: t("validation.required", { ns: "common" }),
                  })}
                />
                {errors.displayName && (
                  <div className="text-sm text-destructive">{errors.displayName.message}</div>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">{t("login.email")}</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="email@example.com"
                  autoComplete="email"
                  aria-invalid={errors.email ? true : undefined}
                  className={cn(errors.email && "border-destructive")}
                  {...register("email", {
                    required: t("validation.required", { ns: "common" }),
                    pattern: {
                      value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                      message: t("validation.emailFormat", { ns: "common" }),
                    },
                  })}
                />
                {errors.email && (
                  <div className="text-sm text-destructive">{errors.email.message}</div>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">{t("login.password")}</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  autoComplete="new-password"
                  aria-invalid={errors.password ? true : undefined}
                  className={cn(errors.password && "border-destructive")}
                  {...register("password", {
                    required: t("validation.required", { ns: "common" }),
                    minLength: {
                      value: 6,
                      message: t("validation.minLength", { ns: "common", min: 6 }),
                    },
                  })}
                />
                {errors.password && (
                  <div className="text-sm text-destructive">{errors.password.message}</div>
                )}
              </div>
              {errors.root && <p className="text-sm text-destructive">{errors.root.message}</p>}
            </div>
            <Button size="lg" className="w-full mt-2" type="submit" disabled={isSubmitting}>
              {isSubmitting ? t("loading") : t("login.signup")}
            </Button>
            {(features.googleAuth || features.githubAuth) && (
              <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t after:border-border">
                <span className="relative z-10 bg-background px-2 text-muted-foreground">
                  {t("login.or")}
                </span>
              </div>
            )}
          </div>
          {(features.googleAuth || features.githubAuth) && (
            <div className="mx-auto w-full max-w-sm flex flex-col gap-2">
              {features.googleAuth && <GoogleSignInButton />}
              {features.githubAuth && <GitHubSignInButton />}
            </div>
          )}
        </div>
      </form>
      <div className="text-balance text-center text-xs text-muted-foreground [&_a]:underline [&_a]:underline-offset-4 hover:[&_a]:text-primary">
        {t("login.termsNotice")} <a href="#">{t("login.termsOfService")}</a> {t("login.and")}{" "}
        <a href="#">{t("login.privacyPolicy")}</a>.
      </div>
    </div>
  );
}
