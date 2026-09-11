// SPDX-License-Identifier: Apache-2.0

import { type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAppForm } from "../hooks/use-app-form";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { useTheme } from "../stores/theme-store";
import { useAuth } from "../hooks/use-auth";
import { useAppConfig } from "../hooks/use-app-config";
import { SocialSignInButton } from "./social-sign-in-button";
import { EmailField, PasswordField } from "./auth-fields";
import { LegalFooter } from "./legal-footer";

type RegisterFormData = {
  displayName: string;
  email: string;
  password: string;
};

interface RegisterFormProps extends React.ComponentPropsWithoutRef<"div"> {
  fixedEmail?: string;
  header?: ReactNode | null;
  footer?: ReactNode | null;
  switchAuthSlot?: ReactNode;
  socialCallbackURL?: string;
  /**
   * Path to navigate to after a successful signup (when no email
   * verification is required). Defaults to `/`. RegisterPage uses this
   * to route the closed-mode bootstrap owner through the rest of the
   * onboarding flow (`/onboarding/create` auto-skips to the next active
   * step since the bootstrap after-hook already created the org).
   */
  redirectAfterSignup?: string;
  /**
   * Pre-fills the display-name field. The user can still edit it. Used
   * by RegisterPage in the closed-mode bootstrap path to derive a
   * sensible name from the locked email so the operator only has to
   * type a password.
   */
  defaultDisplayName?: string;
}

export function RegisterForm({
  className,
  fixedEmail,
  header,
  footer,
  switchAuthSlot,
  socialCallbackURL,
  redirectAfterSignup = "/",
  defaultDisplayName = "",
  ...props
}: RegisterFormProps) {
  const { t } = useTranslation(["settings", "common"]);
  const { resolvedTheme } = useTheme();
  const { signup } = useAuth();
  const { features } = useAppConfig();
  const navigate = useNavigate();

  const {
    register,
    handleSubmit,
    setError,
    showError,
    formState: { errors, isSubmitting },
  } = useAppForm<RegisterFormData>({
    defaultValues: { displayName: defaultDisplayName, email: fixedEmail ?? "", password: "" },
  });

  const onSubmit = async (data: RegisterFormData) => {
    try {
      const result = await signup(data.email, data.password, data.displayName.trim() || undefined);
      if (result.emailVerificationRequired) {
        navigate("/verify-email", { state: { email: data.email } });
      } else {
        navigate(redirectAfterSignup);
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
        {switchAuthSlot ?? (
          <>
            {t("login.hasAccount")}{" "}
            <Link to="/login" className="hover:text-primary underline underline-offset-4">
              {t("login.login")}
            </Link>
          </>
        )}
      </div>
    </div>
  );

  const defaultFooter = <LegalFooter />;

  const resolvedHeader = header === undefined ? defaultHeader : header;
  const resolvedFooter = footer === undefined ? defaultFooter : footer;

  const hasSocialAuth = features.googleAuth || features.githubAuth;

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      {resolvedHeader}
      {header === null && switchAuthSlot && <div className="text-center">{switchAuthSlot}</div>}
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="displayName">{t("login.name")}</Label>
            <Input
              id="displayName"
              type="text"
              placeholder={t("login.namePlaceholder")}
              autoComplete="name"
              aria-invalid={showError("displayName") ? true : undefined}
              className={cn(showError("displayName") && "border-destructive")}
              {...register("displayName", {
                required: t("validation.required", { ns: "common" }),
              })}
            />
            {showError("displayName") && (
              <div className="text-destructive text-sm">{errors.displayName?.message}</div>
            )}
          </div>
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
            autoComplete="new-password"
          />
          {errors.root && <p className="text-destructive text-sm">{errors.root.message}</p>}
        </div>
        <Button size="lg" className="w-full" type="submit" disabled={isSubmitting}>
          {isSubmitting ? t("loading") : t("login.signup")}
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
            </div>
          </>
        )}
      </form>
      {resolvedFooter}
    </div>
  );
}
