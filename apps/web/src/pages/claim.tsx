// SPDX-License-Identifier: Apache-2.0

/**
 * `/claim` — bootstrap-token redemption page.
 *
 * Renders only when `AppConfig.features.bootstrapTokenPending` is true,
 * which the API flips off the moment an organization is created (see
 * `apps/api/src/lib/bootstrap-token.ts`). The form posts directly to
 * `POST /api/auth/bootstrap/redeem` — no Better Auth client involvement
 * because the redeem route owns its own gate. On success, the response
 * sets the BA session cookie and we hard-reload to `/` so the SPA picks
 * up the now-authenticated session AND the freshly-stale AppConfig
 * (which the next request rebuilds with `bootstrapTokenPending: false`).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "../components/auth-layout";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { FormItem } from "@appstrate/ui/components/field";
import { MIN_PASSWORD_LENGTH } from "@appstrate/shared-types";
import { client } from "../api/client";
import { errorMessage } from "../lib/mutation-error";

export function ClaimPage() {
  const { t } = useTranslation(["common"]);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      // Non-2xx throws ApiError (RFC 9457 detail) via the client middleware.
      await client.POST("/api/auth/bootstrap/redeem", {
        body: {
          token: token.trim(),
          email: email.trim(),
          name: name.trim(),
          password,
        },
      });
      // Success: the redeem route already set the session cookie. Hard-reload
      // so the next request sees `bootstrapTokenPending: false` in AppConfig
      // and the SPA flows into the normal authenticated path.
      window.location.href = "/";
    } catch (err) {
      setErrorMsg(errorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="border-primary/30 bg-primary/5 rounded-lg border px-4 py-3 text-sm">
          <p className="font-medium">{t("claim.title")}</p>
          <p className="text-muted-foreground mt-1">{t("claim.subtitle")}</p>
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <FormItem id="claim-token" label={t("claim.tokenLabel")} hint={t("claim.tokenHelp")}>
            <Input
              type="text"
              autoComplete="off"
              spellCheck={false}
              required
              minLength={1}
              maxLength={128}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("claim.tokenPlaceholder")}
            />
          </FormItem>

          <FormItem id="claim-name" label={t("claim.nameLabel")}>
            <Input
              type="text"
              required
              minLength={1}
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormItem>

          <FormItem id="claim-email" label={t("claim.emailLabel")}>
            <Input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </FormItem>

          <FormItem
            id="claim-password"
            label={t("claim.passwordLabel")}
            hint={t("claim.passwordHelp", { min: MIN_PASSWORD_LENGTH })}
          >
            <Input
              type="password"
              required
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </FormItem>

          {errorMsg && (
            <Alert variant="destructive">
              <AlertDescription>{errorMsg}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" pending={submitting}>
            {submitting ? t("claim.submitting") : t("claim.submit")}
          </Button>
        </form>

        <p className="text-muted-foreground text-center text-xs">{t("claim.docs")}</p>
      </div>
    </AuthLayout>
  );
}
