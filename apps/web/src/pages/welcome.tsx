// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { client } from "../api/client";
import { orgStore } from "../stores/org-store";
import { Spinner } from "../components/spinner";
import { AuthLayout } from "../components/auth-layout";

export function WelcomePage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const orgId = searchParams.get("org");

  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const finishAndRedirect = () => {
    if (orgId) {
      orgStore.getState().setId(orgId);
    }
    navigate("/");
    window.location.reload();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    setLoading(true);

    try {
      if (displayName.trim()) {
        // Non-2xx throws ApiError (RFC 9457 detail) via the client middleware.
        await client.POST("/api/welcome/setup", {
          body: { displayName: displayName.trim() },
        });
      }

      finishAndRedirect();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Erreur");
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-xl font-bold">
            <span>App</span>strate
          </h1>
          <p className="text-muted-foreground text-center text-sm">{t("welcome.subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="displayName">{t("welcome.displayName")}</Label>
              <Input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t("login.namePlaceholder")}
                autoComplete="name"
                autoFocus
              />
            </div>

            {serverError && <p className="text-destructive text-sm">{serverError}</p>}

            <Button className="w-full" type="submit" disabled={loading}>
              {loading ? <Spinner /> : t("welcome.save")}
            </Button>
          </div>
        </form>
      </div>
    </AuthLayout>
  );
}
