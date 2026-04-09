// SPDX-License-Identifier: Apache-2.0

import { Fragment, useState, useMemo } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Link } from "react-router-dom";
import { useForm, useWatch } from "react-hook-form";
import { useAppForm } from "../hooks/use-app-form";
import { useQuery } from "@tanstack/react-query";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useTheme } from "../stores/theme-store";
import { useUpdateLanguage, useUpdateDisplayName } from "../hooks/use-profile";
import { useAuth, refreshAuth } from "../hooks/use-auth";
import { useAppConfig } from "../hooks/use-app-config";
import { authClient } from "../lib/auth-client";
import { useDisconnect, useDeleteAllConnections } from "../hooks/use-mutations";
import {
  useConnectionProfiles,
  useAllUserConnections,
  useCreateConnectionProfile,
  useRenameConnectionProfile,
  useDeleteConnectionProfile,
} from "../hooks/use-connection-profiles";
import { ProfileSelector } from "../components/profile-selector";
import { GoogleIcon, GitHubIcon } from "../components/icons";
import { formatDateField } from "../lib/markdown";
import { Unplug, Mail, CheckCircle2, AlertCircle } from "lucide-react";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";

import { ConfirmModal } from "../components/confirm-modal";
import { useProviders } from "../hooks/use-providers";
import { resolveScopeLabel } from "../lib/scope-labels";
import type { UserConnectionProviderGroup, UserConnectionEntry } from "@appstrate/shared-types";
import type { AvailableScope } from "@appstrate/core/validation";

export function PreferencesPage() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const updateLanguage = useUpdateLanguage();
  const [tab, setTab] = useTabWithHash(
    ["general", "appearance", "security", "connectors", "profiles"] as const,
    "general",
  );

  return (
    <>
      <PageHeader
        title={t("preferences.title")}
        emoji="👤"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("preferences.title") },
        ]}
      >
        <Tabs
          value={tab}
          onValueChange={(v) =>
            setTab(v as "general" | "appearance" | "security" | "connectors" | "profiles")
          }
          className="mt-2"
        >
          <TabsList>
            <TabsTrigger value="general">{t("preferences.tabGeneral")}</TabsTrigger>
            <TabsTrigger value="appearance">{t("preferences.tabAppearance")}</TabsTrigger>
            <TabsTrigger value="security">{t("preferences.tabSecurity")}</TabsTrigger>
            <TabsTrigger value="connectors">{t("preferences.tabConnectors")}</TabsTrigger>
            <TabsTrigger value="profiles">{t("preferences.tabProfiles")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

      {tab === "general" && <GeneralTab />}

      {tab === "appearance" && (
        <AppearanceTab
          language={i18n.language}
          onLanguageChange={(lng) => updateLanguage.mutate(lng)}
          languagePending={updateLanguage.isPending}
        />
      )}

      {tab === "security" && <SecurityTab />}

      {tab === "connectors" && <ConnectorsTab />}

      {tab === "profiles" && <ProfilesTab />}
    </>
  );
}

function GeneralTab() {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <>
      <div className="text-muted-foreground mb-4 text-sm font-medium">
        {t("preferences.account")}
      </div>
      <EmailChangeForm />
      <DisplayNameForm />
    </>
  );
}

function AppearanceTab({
  language,
  onLanguageChange,
  languagePending,
}: {
  language: string;
  onLanguageChange: (lng: string) => void;
  languagePending: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { theme, setTheme } = useTheme();

  return (
    <>
      <div className="text-muted-foreground mb-4 text-sm font-medium">{t("preferences.theme")}</div>
      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <Select value={theme} onValueChange={(v) => setTheme(v as "light" | "dark" | "system")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">{t("preferences.themeLight")}</SelectItem>
                <SelectItem value="dark">{t("preferences.themeDark")}</SelectItem>
                <SelectItem value="system">{t("preferences.themeSystem")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="text-muted-foreground mb-4 text-sm font-medium">
        {t("preferences.language")}
      </div>
      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <Select value={language} onValueChange={onLanguageChange} disabled={languagePending}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fr">{t("preferences.langFr")}</SelectItem>
                <SelectItem value="en">{t("preferences.langEn")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </>
  );
}

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

function SecurityTab() {
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

function EmailVerificationBadge() {
  const { t } = useTranslation(["settings", "common"]);
  const { user, resendVerificationEmail } = useAuth();
  const { features } = useAppConfig();
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  if (!features.smtp || !user) return null;

  if (user.emailVerified) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 size={14} />
        <span>{t("preferences.emailVerified")}</span>
      </div>
    );
  }

  const handleResend = async () => {
    setResendState("sending");
    try {
      await resendVerificationEmail(user.email);
      setResendState("sent");
      setTimeout(() => setResendState("idle"), 3000);
    } catch {
      setResendState("idle");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
        <AlertCircle size={14} />
        <span>{t("preferences.emailNotVerified")}</span>
      </div>
      <button
        type="button"
        onClick={handleResend}
        disabled={resendState !== "idle"}
        className="text-primary text-xs underline underline-offset-2 hover:no-underline disabled:no-underline disabled:opacity-50"
      >
        {resendState === "sending"
          ? t("preferences.resendingVerification")
          : resendState === "sent"
            ? t("preferences.verificationResent")
            : t("preferences.resendVerification")}
      </button>
    </div>
  );
}

function EmailChangeForm() {
  const { t } = useTranslation(["settings", "common"]);
  const { user } = useAuth();
  const { features } = useAppConfig();
  const [success, setSuccess] = useState("");
  const [verificationPendingEmail, setVerificationPendingEmail] = useState("");

  const {
    register,
    handleSubmit,
    setError,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm<{ newEmail: string }>({
    defaultValues: { newEmail: "" },
  });

  const newEmailValue = useWatch({ control, name: "newEmail" });
  const isDirty = newEmailValue.trim() !== "" && newEmailValue.trim() !== user?.email;
  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmailValue.trim());
  const canSubmit = isDirty && isValidEmail && !isSubmitting;

  const onSubmit = async (data: { newEmail: string }) => {
    setSuccess("");
    setVerificationPendingEmail("");
    try {
      const result = await authClient.changeEmail({ newEmail: data.newEmail.trim() });
      if (result.error) {
        if (result.error.status === 409) {
          setError("root", { message: t("preferences.emailConflict") });
        } else {
          setError("root", { message: result.error.message || t("login.error") });
        }
      } else {
        reset();
        if (features.smtp) {
          setVerificationPendingEmail(data.newEmail.trim());
        } else {
          setSuccess(t("preferences.emailChanged"));
          await refreshAuth();
        }
      }
    } catch {
      setError("root", { message: t("login.error") });
    }
  };

  return (
    <div className="border-border bg-card mb-4 rounded-lg border p-5">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-1">
        <div className="space-y-2">
          <Label>{t("preferences.email")}</Label>
          <Input type="email" value={user?.email ?? ""} disabled />
          <EmailVerificationBadge />
        </div>
        <div className="space-y-2">
          <Label>{t("preferences.newEmail")}</Label>
          <Input type="email" {...register("newEmail")} placeholder={user?.email ?? ""} />
        </div>
        {errors.root && <div className="text-destructive text-sm">{errors.root.message}</div>}
        {success && <div className="text-success text-sm">{success}</div>}
        {verificationPendingEmail && (
          <div className="text-muted-foreground bg-muted rounded-md px-3 py-2 text-sm">
            <Trans
              ns="settings"
              i18nKey="preferences.emailChangeVerificationSent"
              values={{ email: verificationPendingEmail }}
              components={{ strong: <strong /> }}
            />
          </div>
        )}
        <Button type="submit" disabled={!canSubmit}>
          {isSubmitting ? t("preferences.changingEmail") : t("preferences.changeEmail")}
        </Button>
      </form>
    </div>
  );
}

function DisplayNameForm() {
  const { t } = useTranslation(["settings", "common"]);
  const { profile } = useAuth();
  const updateDisplayName = useUpdateDisplayName();
  const [success, setSuccess] = useState("");

  const { register, handleSubmit, control } = useForm<{ name: string }>({
    defaultValues: { name: profile?.displayName ?? "" },
  });

  const nameValue = useWatch({ control, name: "name" });
  const isDirty = nameValue.trim() !== (profile?.displayName ?? "");
  const canSubmit = nameValue.trim().length > 0 && isDirty && !updateDisplayName.isPending;

  const onSubmit = (data: { name: string }) => {
    setSuccess("");
    updateDisplayName.mutate(data.name.trim(), {
      onSuccess: () => {
        setSuccess(t("preferences.displayNameChanged"));
      },
    });
  };

  return (
    <div className="border-border bg-card mb-4 rounded-lg border p-5">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-1">
        <div className="space-y-2">
          <Label>{t("preferences.displayName")}</Label>
          <Input
            type="text"
            {...register("name")}
            onChange={(e) => {
              register("name").onChange(e);
              setSuccess("");
            }}
            maxLength={100}
          />
        </div>
        {success && <div className="text-success text-sm">{success}</div>}
        <Button type="submit" disabled={!canSubmit}>
          {updateDisplayName.isPending
            ? t("preferences.savingDisplayName")
            : t("preferences.saveDisplayName")}
        </Button>
      </form>
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

function filterProviders(
  providers: UserConnectionProviderGroup[] | undefined,
  profileId: string | null,
): UserConnectionProviderGroup[] {
  if (!providers) return [];
  if (!profileId) return providers;
  return providers
    .map((pg) => {
      const orgs = pg.orgs
        .map((og) => ({
          ...og,
          connections: og.connections.filter((c) => c.profile.id === profileId),
        }))
        .filter((og) => og.connections.length > 0);
      const totalConnections = orgs.reduce((sum, og) => sum + og.connections.length, 0);
      return { ...pg, orgs, totalConnections };
    })
    .filter((pg) => pg.totalConnections > 0);
}

function ConnectionItem({
  conn,
  hasMultipleProfiles,
  onDisconnect,
  disconnecting,
  availableScopes,
}: {
  conn: UserConnectionEntry;
  hasMultipleProfiles: boolean;
  onDisconnect: () => void;
  disconnecting: boolean;
  availableScopes?: AvailableScope[];
}) {
  const { t } = useTranslation(["settings", "common"]);

  const rows: { label: string; value: React.ReactNode }[] = [];
  if (hasMultipleProfiles) {
    rows.push({
      label: t("connectors.profileLabel"),
      value: (
        <>
          {conn.profile.name}
          {conn.profile.isDefault && (
            <span className="border-border bg-background text-muted-foreground ml-1.5 inline-flex items-center rounded-full border px-2 py-px text-[0.65rem]">
              {t("profiles.default")}
            </span>
          )}
        </>
      ),
    });
  }
  rows.push(
    { label: t("connectors.applicationLabel"), value: conn.application.name },
    {
      label: t("connectors.connectedAtLabel"),
      value: conn.connectedAt ? formatDateField(conn.connectedAt) : "\u2014",
    },
  );
  if (conn.scopesGranted.length > 0) {
    rows.push({
      label: t("connectors.scopesLabel"),
      value: conn.scopesGranted.map((s) => resolveScopeLabel(s, availableScopes)).join(", "),
    });
  }

  return (
    <div className="border-border flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map((r) => (
          <Fragment key={r.label}>
            <span className="text-muted-foreground text-xs font-medium">{r.label}</span>
            <span className="text-foreground text-xs">{r.value}</span>
          </Fragment>
        ))}
      </div>
      <Button
        variant="destructive"
        size="sm"
        className="shrink-0"
        onClick={onDisconnect}
        disabled={disconnecting}
      >
        {t("btn.disconnect")}
      </Button>
    </div>
  );
}

function ProviderCard({
  provider: pg,
  expanded,
  onToggle,
  hasMultipleProfiles,
  onDisconnect,
  disconnecting,
  availableScopes,
}: {
  provider: UserConnectionProviderGroup;
  expanded: boolean;
  onToggle: () => void;
  hasMultipleProfiles: boolean;
  onDisconnect: (conn: UserConnectionEntry) => void;
  disconnecting: boolean;
  availableScopes?: AvailableScope[];
}) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <div className="border-border bg-card rounded-lg border p-5">
      <div className="flex cursor-pointer items-center justify-between" onClick={onToggle}>
        <div className="flex items-center gap-3">
          {pg.logo && (
            <img className="h-8 w-8 rounded-md object-contain" src={pg.logo} alt={pg.displayName} />
          )}
          <div className="flex-1">
            <h3 className="text-[0.95rem] font-semibold">{pg.displayName}</h3>
            <span className="text-muted-foreground text-sm">
              {t("connectors.connectionCount", { count: pg.totalConnections })}
            </span>
          </div>
        </div>
        <span
          className={cn(
            "text-muted-foreground text-xs transition-transform duration-200",
            expanded && "rotate-90",
          )}
        >
          &#9654;
        </span>
      </div>

      {expanded && (
        <div className="border-border mt-3 flex flex-col gap-3 border-t pt-3">
          {pg.orgs.map((og) => (
            <div key={og.orgId}>
              <div className="text-muted-foreground mb-2 text-xs font-medium">{og.orgName}</div>
              <div className="flex flex-col gap-2">
                {og.connections.map((conn) => (
                  <ConnectionItem
                    key={conn.connectionId}
                    conn={conn}
                    hasMultipleProfiles={hasMultipleProfiles}
                    availableScopes={availableScopes}
                    onDisconnect={() => onDisconnect(conn)}
                    disconnecting={disconnecting}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectorsTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: userConns, isLoading } = useAllUserConnections();
  const { data: providersData } = useProviders();
  const disconnectMutation = useDisconnect();
  const deleteAllMutation = useDeleteAllConnections();

  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [filterProfileId, setFilterProfileId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<
    | { type: "deleteAll" }
    | {
        type: "disconnect";
        provider: string;
        profile: string;
        connectionId: string;
        providerId: string;
      }
    | null
  >(null);

  const providers = useMemo(
    () => filterProviders(userConns?.providers, filterProfileId),
    [userConns, filterProfileId],
  );

  // Determine if the user has more than one connection profile across all connections.
  // If only one profile exists, we hide the profile row to reduce noise.
  const hasMultipleProfiles = useMemo(() => {
    const ids = new Set<string>();
    for (const pg of providers) {
      for (const og of pg.orgs) {
        for (const conn of og.connections) {
          ids.add(conn.profile.id);
        }
      }
    }
    return ids.size > 1;
  }, [providers]);

  if (isLoading) return <LoadingState />;

  const toggleExpand = (providerId: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  };

  const totalConnections = providers.reduce((sum, pg) => sum + pg.totalConnections, 0);

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-muted-foreground text-sm font-medium">
          {t("connectors.myConnections")}
        </div>
        <ProfileSelector showAllOption value={filterProfileId} onChange={setFilterProfileId} />
      </div>

      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">
            {t("connectors.description")}{" "}
            <Link to="/providers" className="text-primary text-sm no-underline hover:underline">
              {t("connectors.connectMore")}
            </Link>
          </p>
          {totalConnections > 0 && (
            <Button
              variant="destructive"
              onClick={() => setConfirmState({ type: "deleteAll" })}
              disabled={deleteAllMutation.isPending}
            >
              {deleteAllMutation.isPending
                ? t("connectors.deletingAll")
                : t("connectors.deleteAll")}
            </Button>
          )}
        </div>
      </div>

      {providers.length === 0 ? (
        <EmptyState
          message={t("connectors.noConnections")}
          hint={t("connectors.noConnectionsHint")}
          icon={Unplug}
        >
          <Link to="/providers">
            <Button variant="outline">{t("connectors.goToConnectors")}</Button>
          </Link>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {providers.map((pg) => (
            <ProviderCard
              key={pg.providerId}
              provider={pg}
              expanded={expandedProviders.has(pg.providerId)}
              onToggle={() => toggleExpand(pg.providerId)}
              hasMultipleProfiles={hasMultipleProfiles}
              onDisconnect={(conn) =>
                setConfirmState({
                  type: "disconnect",
                  provider: pg.displayName,
                  profile: conn.profile.name,
                  connectionId: conn.connectionId,
                  providerId: pg.providerId,
                })
              }
              disconnecting={disconnectMutation.isPending}
              availableScopes={
                providersData?.providers?.find((p) => p.id === pg.providerId)?.availableScopes
              }
            />
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={
          confirmState?.type === "deleteAll"
            ? t("connectors.deleteAllConfirm")
            : confirmState?.type === "disconnect"
              ? t("connectors.deleteConfirm", {
                  provider: confirmState.provider,
                  profile: confirmState.profile,
                })
              : ""
        }
        isPending={
          confirmState?.type === "deleteAll"
            ? deleteAllMutation.isPending
            : disconnectMutation.isPending
        }
        onConfirm={() => {
          if (confirmState?.type === "deleteAll") {
            deleteAllMutation.mutate(undefined, {
              onSuccess: () => setConfirmState(null),
            });
          } else if (confirmState?.type === "disconnect") {
            disconnectMutation.mutate(
              { provider: confirmState.providerId, connectionId: confirmState.connectionId },
              { onSuccess: () => setConfirmState(null) },
            );
          }
        }}
      />
    </>
  );
}

function ProfilesTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: profiles, isLoading, error } = useConnectionProfiles();
  const createProfile = useCreateConnectionProfile();
  const renameProfile = useRenameConnectionProfile();
  const deleteProfile = useDeleteConnectionProfile();

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmState, setConfirmState] = useState<{ label: string; id: string } | null>(null);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const handleCreate = () => {
    if (newName.trim()) {
      createProfile.mutate(newName.trim(), {
        onSuccess: () => setNewName(""),
      });
    }
  };

  return (
    <>
      <div className="text-muted-foreground mb-4 text-sm font-medium">{t("profiles.title")}</div>

      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <div className="flex items-center gap-2 py-1">
          <Input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("profiles.namePlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim() && !createProfile.isPending) handleCreate();
            }}
          />
          <Button onClick={handleCreate} disabled={!newName.trim() || createProfile.isPending}>
            {t("profiles.create")}
          </Button>
        </div>
      </div>

      {profiles && profiles.length > 0 && (
        <div className="flex flex-col gap-3">
          {profiles.map((profile) => (
            <div key={profile.id} className="border-border bg-card rounded-lg border p-5">
              <div className="mb-3 flex items-center gap-3">
                <div className="flex-1">
                  {editingId === profile.id ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && editName.trim()) {
                            renameProfile.mutate(
                              { id: profile.id, name: editName.trim() },
                              { onSuccess: () => setEditingId(null) },
                            );
                          }
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        autoFocus
                      />
                      <Button
                        size="sm"
                        onClick={() => {
                          if (editName.trim()) {
                            renameProfile.mutate(
                              { id: profile.id, name: editName.trim() },
                              { onSuccess: () => setEditingId(null) },
                            );
                          }
                        }}
                        disabled={!editName.trim() || renameProfile.isPending}
                      >
                        {t("btn.save")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                        {t("btn.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <h3 className="text-[0.95rem] font-semibold">
                        {profile.name}
                        {profile.isDefault && (
                          <span className="border-border bg-background text-muted-foreground ml-1.5 inline-flex items-center rounded-full border px-2 py-px text-[0.7rem]">
                            {t("profiles.default")}
                          </span>
                        )}
                      </h3>
                      <span className="text-muted-foreground text-sm">
                        {t("profiles.connections", { count: profile.connectionCount })}
                      </span>
                    </>
                  )}
                </div>
              </div>
              {editingId !== profile.id && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingId(profile.id);
                      setEditName(profile.name);
                    }}
                  >
                    {t("profiles.rename")}
                  </Button>
                  {!profile.isDefault && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setConfirmState({ label: profile.name, id: profile.id })}
                      disabled={deleteProfile.isPending}
                    >
                      {t("profiles.delete")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={confirmState ? t("profiles.deleteConfirm", { name: confirmState.label }) : ""}
        isPending={deleteProfile.isPending}
        onConfirm={() => {
          if (confirmState) {
            deleteProfile.mutate(confirmState.id, {
              onSuccess: () => setConfirmState(null),
            });
          }
        }}
      />
    </>
  );
}
