// SPDX-License-Identifier: Apache-2.0

/**
 * `/claim` — bootstrap-token redemption page (#344 Layer 2b).
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getErrorMessage } from "@appstrate/core/errors";

interface RedeemResponse {
  bootstrap?: { orgId: string; orgSlug: string };
  error?: { detail?: string; title?: string; code?: string };
  detail?: string;
  title?: string;
  code?: string;
}

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
      const res = await fetch("/api/auth/bootstrap/redeem", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: token.trim(),
          email: email.trim(),
          name: name.trim(),
          password,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as RedeemResponse;
      if (!res.ok) {
        const detail = body.detail ?? body.title ?? `${res.status} ${res.statusText}`;
        setErrorMsg(detail);
        setSubmitting(false);
        return;
      }
      // Success: the redeem route already set the session cookie. Hard-reload
      // so the next request sees `bootstrapTokenPending: false` in AppConfig
      // and the SPA flows into the normal authenticated path.
      window.location.href = "/";
    } catch (err) {
      const msg = getErrorMessage(err);
      setErrorMsg(msg);
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
          <div className="flex flex-col gap-2">
            <Label htmlFor="claim-token">{t("claim.tokenLabel")}</Label>
            <Input
              id="claim-token"
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
            <p className="text-muted-foreground text-xs">{t("claim.tokenHelp")}</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="claim-name">{t("claim.nameLabel")}</Label>
            <Input
              id="claim-name"
              type="text"
              required
              minLength={1}
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="claim-email">{t("claim.emailLabel")}</Label>
            <Input
              id="claim-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="claim-password">{t("claim.passwordLabel")}</Label>
            <Input
              id="claim-password"
              type="password"
              required
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">{t("claim.passwordHelp")}</p>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm"
            >
              {errorMsg}
            </div>
          )}

          <Button type="submit" disabled={submitting}>
            {submitting ? t("claim.submitting") : t("claim.submit")}
          </Button>
        </form>

        <p className="text-muted-foreground text-center text-xs">{t("claim.docs")}</p>
      </div>
    </AuthLayout>
  );
}
