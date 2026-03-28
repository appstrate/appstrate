import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "../hooks/use-auth";
import { GitHubIcon } from "./icons";

export function GitHubSignInButton({
  callbackURL: callbackURLProp,
}: { callbackURL?: string } = {}) {
  const { t } = useTranslation("settings");
  const { signInWithGithub } = useAuth();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);

  return (
    <Button
      variant="outline"
      className="w-full text-foreground"
      type="button"
      disabled={loading}
      onClick={async () => {
        setLoading(true);
        try {
          const redirect = searchParams.get("redirect");
          const callbackURL =
            callbackURLProp ?? (redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : "/");
          await signInWithGithub(callbackURL);
        } finally {
          setLoading(false);
        }
      }}
    >
      <GitHubIcon />
      {t("login.continueGithub")}
    </Button>
  );
}
