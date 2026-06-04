// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "../hooks/use-auth";
import { GitHubIcon, GoogleIcon } from "./icons";

type SocialProvider = "github" | "google";

const PROVIDERS: Record<SocialProvider, { icon: React.ComponentType; labelKey: string }> = {
  github: { icon: GitHubIcon, labelKey: "login.continueGithub" },
  google: { icon: GoogleIcon, labelKey: "login.continueGoogle" },
};

export function SocialSignInButton({
  provider,
  callbackURL: callbackURLProp,
}: {
  provider: SocialProvider;
  callbackURL?: string;
}) {
  const { t } = useTranslation("settings");
  const { signInWithSocial } = useAuth();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);

  const { icon: Icon, labelKey } = PROVIDERS[provider];

  return (
    <Button
      variant="outline"
      className="text-foreground w-full"
      type="button"
      disabled={loading}
      onClick={async () => {
        setLoading(true);
        try {
          const redirect = searchParams.get("redirect");
          const callbackURL =
            callbackURLProp ?? (redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : "/");
          await signInWithSocial(provider, callbackURL);
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
