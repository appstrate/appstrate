// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { useAppForm } from "../../hooks/use-app-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useAuth } from "../../hooks/use-auth";
import { useAppConfig } from "../../hooks/use-app-config";
import { authClient } from "../../lib/auth-client";
import { GoogleIcon, GitHubIcon } from "../../components/icons";

function LinkedAccountsSection() {
  const { t } = useTranslation(["settings", "common"]);
  const { features } = useAppConfig();
  const { linkGoogle, linkGithub, unlinkAccount } = useAuth();
  const [unlinking, setUnlinking] = useState<string | false>(false);
  const [linking, setLinking] = useState<string | false>(false);

  const { data: accounts, refetch } = useQuery({
    queryKey: ["linked-accounts"],
    queryFn: async () => {
      const result = await authClient.listAccounts();
      if (result.error) throw new Error(result.error.message);
      return result.data ?? [];
    },
  });

  if (!features.googleAuth && !features.githubAuth) return null;

  const googleAccount = accounts?.find((a) => a.providerId === "google");
  const githubAccount = accounts?.find((a) => a.providerId === "github");
  const credentialAccount = accounts?.find((a) => a.providerId === "credential");
  const totalAccounts = accounts?.length ?? 0;
  const canUnlink = totalAccounts > 1;

  const socialProviders = [
    ...(features.googleAuth
      ? [
          {
            id: "google",
            name: "Google",
            icon: GoogleIcon,
            account: googleAccount,
            link: linkGoogle,
            linkingKey: "preferences.linkingGoogle" as const,
            linkKey: "preferences.linkGoogle" as const,
          },
        ]
      : []),
    ...(features.githubAuth
      ? [
          {
            id: "github",
            name: "GitHub",
            icon: GitHubIcon,
            account: githubAccount,
            link: linkGithub,
            linkingKey: "preferences.linkingGithub" as const,
            linkKey: "preferences.linkGithub" as const,
          },
        ]
      : []),
  ];

  return (
    <div className="mb-6">
      <div className="text-muted-foreground mb-4 text-sm font-medium">
        {t("preferences.linkedAccounts")}
      </div>
      <p className="text-muted-foreground mb-4 text-sm">
        {t("preferences.linkedAccountsDescription")}
      </p>
      <div className="space-y-3">
        {credentialAccount && (
          <div className="border-border bg-card flex items-center justify-between rounded-lg border p-4">
            <div className="flex items-center gap-3">
              <div className="bg-muted flex h-8 w-8 items-center justify-center rounded-full">
                <Mail size={16} />
              </div>
              <span className="text-sm font-medium">{t("preferences.emailPassword")}</span>
            </div>
            <span className="text-muted-foreground text-xs">
              {t("preferences.linkedVia", { provider: "Email" })}
            </span>
          </div>
        )}
        {socialProviders.map((provider) => {
          const Icon = provider.icon;
          return provider.account ? (
            <div
              key={provider.id}
              className="border-border bg-card flex items-center justify-between rounded-lg border p-4"
            >
              <div className="flex items-center gap-3">
                <Icon className="h-5 w-5" />
                <div>
                  <span className="text-sm font-medium">{provider.name}</span>
                  <div className="text-muted-foreground text-xs">{provider.account.accountId}</div>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={!canUnlink || unlinking === provider.id}
                title={!canUnlink ? t("preferences.cannotUnlinkLast") : undefined}
                onClick={async () => {
                  setUnlinking(provider.id);
                  try {
                    await unlinkAccount(provider.id);
                    await refetch();
                  } finally {
                    setUnlinking(false);
                  }
                }}
              >
                {unlinking === provider.id
                  ? t("preferences.unlinking")
                  : t("preferences.unlinkGoogle")}
              </Button>
            </div>
          ) : (
            <div
              key={provider.id}
              className="border-border bg-card flex items-center justify-between rounded-lg border border-dashed p-4"
            >
              <div className="flex items-center gap-3">
                <Icon className="h-5 w-5" />
                <span className="text-muted-foreground text-sm font-medium">{provider.name}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={linking === provider.id}
                onClick={async () => {
                  setLinking(provider.id);
                  try {
                    await provider.link();
                  } finally {
                    setLinking(false);
                  }
                }}
              >
                {linking === provider.id ? t(provider.linkingKey) : t(provider.linkKey)}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface PasswordFormData {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

function PasswordChangeForm() {
  const { t } = useTranslation(["settings", "common"]);
  const { updatePassword } = useAuth();
  const [success, setSuccess] = useState("");

  const {
    register,
    handleSubmit,
    setError,
    reset,
    control,
    showError,
    formState: { errors, isSubmitting },
  } = useAppForm<PasswordFormData>({
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const newPasswordValue = useWatch({ control, name: "newPassword" });

  const onSubmit = async (data: PasswordFormData) => {
    setSuccess("");
    try {
      await updatePassword(data.currentPassword, data.newPassword);
      setSuccess(t("preferences.passwordChanged"));
      reset();
    } catch (err: unknown) {
      setError("root", {
        message: err instanceof Error ? err.message : t("login.error"),
      });
    }
  };

  return (
    <div className="border-border bg-card mb-4 rounded-lg border p-5">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-1">
        <div className="space-y-2">
          <Label>{t("preferences.currentPassword")}</Label>
          <Input
            type="password"
            {...register("currentPassword", {
              required: t("validation.required", { ns: "common" }),
            })}
            autoComplete="current-password"
            aria-invalid={showError("currentPassword") ? true : undefined}
            className={cn(showError("currentPassword") && "border-destructive")}
          />
          {showError("currentPassword") && (
            <div className="text-destructive text-sm">{errors.currentPassword?.message}</div>
          )}
        </div>
        <div className="space-y-2">
          <Label>{t("preferences.newPassword")}</Label>
          <Input
            type="password"
            {...register("newPassword", {
              required: t("validation.required", { ns: "common" }),
              minLength: {
                value: 6,
                message: t("validation.minLength", { ns: "common", min: 6 }),
              },
            })}
            minLength={6}
            autoComplete="new-password"
            aria-invalid={showError("newPassword") ? true : undefined}
            className={cn(showError("newPassword") && "border-destructive")}
          />
          {showError("newPassword") && (
            <div className="text-destructive text-sm">{errors.newPassword?.message}</div>
          )}
        </div>
        <div className="space-y-2">
          <Label>{t("preferences.confirmPassword")}</Label>
          <Input
            type="password"
            {...register("confirmPassword", {
              required: t("validation.required", { ns: "common" }),
              validate: (v) =>
                v === newPasswordValue || t("validation.passwordMismatch", { ns: "common" }),
            })}
            autoComplete="new-password"
            aria-invalid={showError("confirmPassword") ? true : undefined}
            className={cn(showError("confirmPassword") && "border-destructive")}
          />
          {showError("confirmPassword") && (
            <div className="text-destructive text-sm">{errors.confirmPassword?.message}</div>
          )}
        </div>
        {errors.root && <div className="text-destructive text-sm">{errors.root.message}</div>}
        {success && <div className="text-success text-sm">{success}</div>}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t("preferences.changingPassword") : t("preferences.changePassword")}
        </Button>
      </form>
    </div>
  );
}

export function PreferencesSecurityPage() {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <>
      <LinkedAccountsSection />
      <div className="text-muted-foreground mb-4 text-sm font-medium">
        {t("preferences.changePassword")}
      </div>
      <PasswordChangeForm />
    </>
  );
}
