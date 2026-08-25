// SPDX-License-Identifier: Apache-2.0

import { type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAppForm } from "../hooks/use-app-form";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { useTheme } from "../stores/theme-store";
import { useAuth } from "../hooks/use-auth";
import { useAppConfig } from "../hooks/use-app-config";
import { Mail } from "lucide-react";
import { SocialSignInButton } from "./social-sign-in-button";
import { EmailField, PasswordField } from "./auth-fields";
import { LegalFooter } from "./legal-footer";

type LoginFormData = {
  email: string;
  password: string;
};

interface LoginFormProps extends React.ComponentPropsWithoutRef<"div"> {
  fixedEmail?: string;
  onSuccess?: () => Promise<void>;
  header?: ReactNode | null;
  footer?: ReactNode | null;
  switchAuthSlot?: ReactNode;
  socialCallbackURL?: string;
}

export function LoginForm({
  className,
  fixedEmail,
  onSuccess,
  header,
  footer,
  switchAuthSlot,
  socialCallbackURL,
  ...props
}: LoginFormProps) {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const { login } = useAuth();
  const { features } = useAppConfig();

  const {
    register,
    handleSubmit,
    setError,
    showError,
    getValues,
    formState: { errors, isSubmitting },
  } = useAppForm<LoginFormData>({
    defaultValues: { email: fixedEmail ?? "", password: "" },
  });

  const onSubmit = async (data: LoginFormData) => {
    try {
      await login(fixedEmail ?? data.email, data.password);
      if (onSuccess) {
        await onSuccess();
      }
    } catch (err) {
      setError("root", {
        message: err instanceof Error ? err.message : t("login.error"),
      });
    }
  };

  const defaultHeader = (
    <div className="flex flex-col items-center gap-2">
      <Link to="/" className="flex flex-col items-center gap-2 font-medium">
        <img
          src={resolvedTheme === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
          alt="Appstrate"
          className="h-11"
        />
      </Link>
      <div className="text-muted-foreground text-center text-sm">
        {switchAuthSlot ??
          (features.signupDisabled ? (
            // Closed-mode self-host (issue #228) — no public registration.
            // Existing accounts and invitees still sign in normally above.
            <span>{t("login.signupDisabled")}</span>
          ) : (
            <>
              {t("login.noAccount")}{" "}
              <Link to="/register" className="hover:text-primary underline underline-offset-4">
                {t("login.signup")}
              </Link>
            </>
          ))}
      </div>
    </div>
  );

  const defaultFooter = <LegalFooter />;

  const resolvedHeader = header === undefined ? defaultHeader : header;
  const resolvedFooter = footer === undefined ? defaultFooter : footer;

  const hasSocialAuth = features.googleAuth || features.githubAuth || features.smtp;

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      {resolvedHeader}
      {header === null && switchAuthSlot && <div className="text-center">{switchAuthSlot}</div>}
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          <EmailField
            register={register}
            name="email"
            label={t("login.email")}
            invalid={showError("email")}
            error={errors.email?.message}
            fixedValue={fixedEmail}
          />
          <PasswordField
            register={register}
            name="password"
            label={t("login.password")}
            invalid={showError("password")}
            error={errors.password?.message}
            autoComplete="current-password"
            labelAction={
              features.smtp && (
                <Link
                  to="/forgot-password"
                  className="text-muted-foreground hover:text-primary text-xs underline-offset-4 hover:underline"
                >
                  {t("login.forgotPassword")}
                </Link>
              )
            }
          />
          {errors.root && <p className="text-destructive text-sm">{errors.root.message}</p>}
        </div>
        <Button size="lg" className="w-full" type="submit" disabled={isSubmitting}>
          {isSubmitting ? t("loading") : t("login.login")}
        </Button>
        {hasSocialAuth && (
          <>
            <div className="after:border-border relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t">
              <span className="bg-background text-muted-foreground relative z-10 px-2">
                {t("login.or")}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {features.googleAuth && (
                <SocialSignInButton provider="google" callbackURL={socialCallbackURL} />
              )}
              {features.githubAuth && (
                <SocialSignInButton provider="github" callbackURL={socialCallbackURL} />
              )}
              {features.smtp && (
                <Button
                  variant="outline"
                  className="text-foreground w-full"
                  type="button"
                  onClick={() => navigate("/magic-link", { state: { email: getValues("email") } })}
                >
                  <Mail className="h-4 w-4" />
                  {t("login.magicLink")}
                </Button>
              )}
            </div>
          </>
        )}
      </form>
      {resolvedFooter}
    </div>
  );
}
