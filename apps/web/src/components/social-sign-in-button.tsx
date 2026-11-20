// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
import { useAuth } from "../hooks/use-auth";
import { GitHubIcon, GoogleIcon, MicrosoftIcon } from "./icons";

type SocialProvider = "github" | "google" | "microsoft";

const PROVIDERS: Record<SocialProvider, { icon: React.ComponentType; labelKey: string }> = {
  github: { icon: GitHubIcon, labelKey: "login.continueGithub" },
  google: { icon: GoogleIcon, labelKey: "login.continueGoogle" },
  microsoft: { icon: MicrosoftIcon, labelKey: "login.continueMicrosoft" },
};

export function SocialSignInButton({
  provider,
  callbackURL: callbackURLProp,
  errorCallbackURL,
  disabled,
  emphasized = false,
}: {
  provider: SocialProvider;
  callbackURL?: string;
  /** Where a refused callback lands with `?error=<code>`; Better Auth's own error page otherwise. */
  errorCallbackURL?: string;
  disabled?: boolean;
  /** The way in a refusal points to (an organization that requires Microsoft). */
  emphasized?: boolean;
}) {
  const { t } = useTranslation("settings");
  const { signInWithSocial } = useAuth();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);

  const { icon: Icon, labelKey } = PROVIDERS[provider];

  return (
    <Button
      variant={emphasized ? "default" : "outline"}
      className={emphasized ? "w-full" : "text-foreground w-full"}
      type="button"
      disabled={loading || disabled}
      onClick={async () => {
        setLoading(true);
        try {
          const redirect = searchParams.get("redirect");
          const callbackURL =
            callbackURLProp ?? (redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : "/");
          await signInWithSocial(provider, callbackURL, errorCallbackURL);
        } finally {
          setLoading(false);
        }
      }}
    >
      <Icon />
      {t(labelKey)}
    </Button>
  );
}
