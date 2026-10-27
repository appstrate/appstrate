// SPDX-License-Identifier: Apache-2.0

/**
 * `/claim`: bootstrap-token redemption, shown only while
 * `AppConfig.features.bootstrapTokenPending` (flipped off once an organization
 * exists, `apps/api/src/lib/bootstrap-token.ts`). Posts directly to
 * `/api/auth/bootstrap/redeem` (no Better Auth client: the route owns its gate).
 */

import { PendingButton } from "@/components/app-ui/pending-button";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "../components/auth-layout";
import { Input } from "@appstrate/ui/components/input";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { FormItem } from "@/components/app-ui/form-item";
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
      await client.POST("/api/auth/bootstrap/redeem", {
        body: {
          token: token.trim(),
          email: email.trim(),
          name: name.trim(),
          password,
        },
      });
      // The session cookie is set: hard-reload so AppConfig is rebuilt with `bootstrapTokenPending: false`.
      window.location.href = "/";
    } catch (err) {
      setErrorMsg(errorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <Alert variant="info" className="px-4 py-3 text-sm">
          <AlertTitle>{t("claim.title")}</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            {t("claim.subtitle")}
          </AlertDescription>
        </Alert>

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

          <PendingButton type="submit" pending={submitting}>
            {submitting ? t("claim.submitting") : t("claim.submit")}
          </PendingButton>
        </form>

        <p className="text-muted-foreground text-center text-xs">{t("claim.docs")}</p>
      </div>
    </AuthLayout>
  );
}
