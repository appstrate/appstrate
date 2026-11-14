// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAppForm } from "../hooks/use-app-form";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { FieldError } from "@appstrate/ui/components/field";
import { useTheme } from "../stores/theme-store";
import { useAuth } from "../hooks/use-auth";
import { useAppConfig } from "../hooks/use-app-config";
import { Mail } from "lucide-react";
import { SocialSignInButton } from "./social-sign-in-button";
import { EmailField, PasswordField } from "./auth-fields";
import { AuthLink } from "./auth-message";
import { LegalFooter } from "./legal-footer";
import { EmailNotVerifiedError } from "../lib/auth-errors";
import { errorMessage, refusalMessage } from "../lib/mutation-error";
import { ApiError } from "../api/errors";
import { errorCallbackURL, isSsoRefusal, socialCallbackError } from "../lib/org-sso";

type LoginFormData = {
  email: string;
  password: string;
};

interface LoginFormProps extends React.ComponentPropsWithoutRef<"div"> {
  fixedEmail?: string;
  header?: ReactNode | null;
  footer?: ReactNode | null;
  switchAuthSlot?: ReactNode;
  /** Where a social sign-in, or the verification link of an unverified account, lands. */
  callbackURL?: string;
}

export function LoginForm({
  className,
  fixedEmail,
  header,
  footer,
  switchAuthSlot,
  callbackURL,
  ...props
}: LoginFormProps) {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const location = useLocation();
  const { resolvedTheme } = useTheme();
  const { login } = useAuth();
  const { features } = useAppConfig();

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    showError,
    getValues,
    formState: { errors, isSubmitting },
  } = useAppForm<LoginFormData>({
    defaultValues: { email: fixedEmail ?? "", password: "" },
  });

  // An owner's way in while their organization requires Microsoft and Microsoft is down. Offered
  // only where the enterprise sign-in module runs; its failure reads like any wrong password.
  const [emergency, setEmergency] = useState(false);
  // The refusal of the last password attempt, when it names the organization's sign-in policy.
  const [passwordRefusal, setPasswordRefusal] = useState<string | null>(null);

  // A social sign-in refused at its callback comes back here with `?error=<code>`.
  const callbackError = socialCallbackError(location.search);
  const callbackMessage = callbackError
    ? (refusalMessage({ code: callbackError }) ?? t("login.socialFailed"))
    : null;
  const socialErrorCallbackURL = errorCallbackURL(location.pathname, location.search);
  const pointToMicrosoft = isSsoRefusal(passwordRefusal) || isSsoRefusal(callbackError);

  const toggleEmergency = () => {
    setEmergency((on) => !on);
    setPasswordRefusal(null);
    clearErrors("root");
  };

  const onSubmit = async (data: LoginFormData) => {
    const email = fixedEmail ?? data.email;
    try {
      await login(email, data.password, callbackURL, { emergency });
    } catch (err) {
      if (err instanceof EmailNotVerifiedError) {
        navigate("/verify-email", { state: { email, callbackURL } });
        return;
      }
      setPasswordRefusal(err instanceof ApiError ? err.code.toLowerCase() : null);
      setError("root", { message: errorMessage(err) });
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
            // Closed-mode self-host — no public registration.
            // Existing accounts and invitees still sign in normally above.
            <span>{t("login.signupDisabled")}</span>
          ) : (
            <>
              {t("login.noAccount")} <AuthLink to="/register">{t("login.signup")}</AuthLink>
            </>
          ))}
      </div>
    </div>
  );

  const defaultFooter = <LegalFooter />;

  const resolvedHeader = header === undefined ? defaultHeader : header;
  const resolvedFooter = footer === undefined ? defaultFooter : footer;

  const hasSocialAuth =
    features.googleAuth || features.githubAuth || features.microsoftAuth || features.smtp;

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
            label={t("common:claim.passwordLabel")}
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
          {(errors.root?.message ?? callbackMessage) && (
            <FieldError>{errors.root?.message ?? callbackMessage}</FieldError>
          )}
          {emergency && <p className="text-muted-foreground text-xs">{t("login.emergencyHint")}</p>}
        </div>
        <Button size="lg" className="w-full" type="submit" disabled={isSubmitting}>
          {isSubmitting ? t("loading") : emergency ? t("login.emergencySubmit") : t("login.login")}
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
                <SocialSignInButton
                  provider="google"
                  callbackURL={callbackURL}
                  errorCallbackURL={socialErrorCallbackURL}
                />
              )}
              {features.githubAuth && (
                <SocialSignInButton
                  provider="github"
                  callbackURL={callbackURL}
                  errorCallbackURL={socialErrorCallbackURL}
                />
              )}
              {features.microsoftAuth && (
                <SocialSignInButton
                  provider="microsoft"
                  callbackURL={callbackURL}
                  errorCallbackURL={socialErrorCallbackURL}
                  emphasized={pointToMicrosoft}
                />
              )}
              {features.smtp && (
                <Button
                  variant="outline"
                  className="text-foreground w-full"
                  type="button"
                  onClick={() => navigate("/magic-link", { state: { email: getValues("email") } })}
                >
                  <Mail />
                  {t("login.magicLink")}
                </Button>
              )}
            </div>
          </>
        )}
        {features.enterpriseSso && (
          <button
            type="button"
            onClick={toggleEmergency}
            className="text-muted-foreground hover:text-primary self-center text-xs underline-offset-4 hover:underline"
          >
            {emergency ? t("login.emergencyLeave") : t("login.emergencyLink")}
          </button>
        )}
      </form>
      {resolvedFooter}
    </div>
  );
}
