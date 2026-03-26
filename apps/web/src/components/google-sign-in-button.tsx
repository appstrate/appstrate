import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "../hooks/use-auth";
import { GoogleIcon } from "./icons";

export function GoogleSignInButton() {
  const { t } = useTranslation("settings");
  const { signInWithGoogle } = useAuth();
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
          // Preserve ?redirect param through Google OAuth flow
          const redirect = searchParams.get("redirect");
          const callbackURL = redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : "/";
          await signInWithGoogle(callbackURL);
        } finally {
          setLoading(false);
        }
      }}
    >
      <GoogleIcon />
      {t("login.continueGoogle")}
    </Button>
  );
}
