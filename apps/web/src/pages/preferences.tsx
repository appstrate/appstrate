import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useForm, useWatch } from "react-hook-form";
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
import { useTheme } from "../hooks/use-theme";
import { useUpdateLanguage, useUpdateDisplayName } from "../hooks/use-profile";
import { useAuth, refreshAuth } from "../hooks/use-auth";
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
import { formatDateField } from "../lib/markdown";
import { Unplug } from "lucide-react";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";

import type { UserConnectionProviderGroup } from "@appstrate/shared-types";

export function PreferencesPage() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const updateLanguage = useUpdateLanguage();
  const [tab, setTab] = useTabWithHash(
    ["general", "appearance", "security", "connectors", "profiles"] as const,
    "general",
  );

  return (
    <>
      <div className="mb-6">
        <h2>{t("preferences.title")}</h2>
      </div>
      <Tabs
        value={tab}
        onValueChange={(v) =>
          setTab(v as "general" | "appearance" | "security" | "connectors" | "profiles")
        }
      >
        <TabsList className="mb-4">
          <TabsTrigger value="general">{t("preferences.tabGeneral")}</TabsTrigger>
          <TabsTrigger value="appearance">{t("preferences.tabAppearance")}</TabsTrigger>
          <TabsTrigger value="security">{t("preferences.tabSecurity")}</TabsTrigger>
          <TabsTrigger value="connectors">{t("preferences.tabConnectors")}</TabsTrigger>
          <TabsTrigger value="profiles">{t("preferences.tabProfiles")}</TabsTrigger>
        </TabsList>
      </Tabs>

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
      <div className="text-sm font-medium text-muted-foreground mb-4">
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
      <div className="text-sm font-medium text-muted-foreground mb-4">{t("preferences.theme")}</div>
      <div className="rounded-lg border border-border bg-card p-5 mb-4">
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

      <div className="text-sm font-medium text-muted-foreground mb-4">
        {t("preferences.language")}
      </div>
      <div className="rounded-lg border border-border bg-card p-5 mb-4">
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

function SecurityTab() {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <>
      <div className="text-sm font-medium text-muted-foreground mb-4">
        {t("preferences.changePassword")}
      </div>
      <PasswordChangeForm />
    </>
  );
}

function EmailChangeForm() {
  const { t } = useTranslation(["settings", "common"]);
  const { user } = useAuth();
  const [success, setSuccess] = useState("");

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
    try {
      const result = await authClient.changeEmail({ newEmail: data.newEmail.trim() });
      if (result.error) {
        if (result.error.status === 409) {
          setError("root", { message: t("preferences.emailConflict") });
        } else {
          setError("root", { message: result.error.message || t("login.error") });
        }
      } else {
        setSuccess(t("preferences.emailChanged"));
        reset();
        await refreshAuth();
      }
    } catch {
      setError("root", { message: t("login.error") });
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 mb-4">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-1">
        <div className="space-y-2">
          <Label>{t("preferences.email")}</Label>
          <Input type="email" value={user?.email ?? ""} disabled />
        </div>
        <div className="space-y-2">
          <Label>{t("preferences.newEmail")}</Label>
          <Input type="email" {...register("newEmail")} placeholder={user?.email ?? ""} />
        </div>
        {errors.root && <div className="text-sm text-destructive">{errors.root.message}</div>}
        {success && <div className="text-sm text-success">{success}</div>}
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
    <div className="rounded-lg border border-border bg-card p-5 mb-4">
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
        {success && <div className="text-sm text-success">{success}</div>}
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
    formState: { errors, isSubmitting },
  } = useForm<PasswordFormData>({
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
    mode: "onBlur",
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
    <div className="rounded-lg border border-border bg-card p-5 mb-4">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-1">
        <div className="space-y-2">
          <Label>{t("preferences.currentPassword")}</Label>
          <Input
            type="password"
            {...register("currentPassword", {
              required: t("validation.required", { ns: "common" }),
            })}
            autoComplete="current-password"
            aria-invalid={errors.currentPassword ? true : undefined}
            className={cn(errors.currentPassword && "border-destructive")}
          />
          {errors.currentPassword && (
            <div className="text-sm text-destructive">{errors.currentPassword.message}</div>
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
            aria-invalid={errors.newPassword ? true : undefined}
            className={cn(errors.newPassword && "border-destructive")}
          />
          {errors.newPassword && (
            <div className="text-sm text-destructive">{errors.newPassword.message}</div>
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
            aria-invalid={errors.confirmPassword ? true : undefined}
            className={cn(errors.confirmPassword && "border-destructive")}
          />
          {errors.confirmPassword && (
            <div className="text-sm text-destructive">{errors.confirmPassword.message}</div>
          )}
        </div>
        {errors.root && <div className="text-sm text-destructive">{errors.root.message}</div>}
        {success && <div className="text-sm text-success">{success}</div>}
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

function ConnectorsTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: userConns, isLoading } = useAllUserConnections();
  const disconnectMutation = useDisconnect();
  const deleteAllMutation = useDeleteAllConnections();

  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [filterProfileId, setFilterProfileId] = useState<string | null>(null);

  const providers = useMemo(
    () => filterProviders(userConns?.providers, filterProfileId),
    [userConns, filterProfileId],
  );

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
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-medium text-muted-foreground">
          {t("connectors.myConnections")}
        </div>
        <ProfileSelector showAllOption value={filterProfileId} onChange={setFilterProfileId} />
      </div>

      <div className="rounded-lg border border-border bg-card p-5 mb-4">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {t("connectors.description")}{" "}
            <Link to="/providers" className="text-primary text-sm no-underline hover:underline">
              {t("connectors.connectMore")}
            </Link>
          </p>
          {totalConnections > 0 && (
            <Button
              variant="destructive"
              onClick={() => {
                if (confirm(t("connectors.deleteAllConfirm"))) {
                  deleteAllMutation.mutate();
                }
              }}
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
          {providers.map((pg) => {
            const expanded = expandedProviders.has(pg.providerId);

            return (
              <div key={pg.providerId} className="rounded-lg border border-border bg-card p-5">
                <div
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => toggleExpand(pg.providerId)}
                >
                  <div className="flex items-center gap-3">
                    {pg.logo && (
                      <img
                        className="h-8 w-8 rounded-md object-contain"
                        src={pg.logo}
                        alt={pg.displayName}
                      />
                    )}
                    <div className="flex-1">
                      <h3 className="text-[0.95rem] font-semibold">{pg.displayName}</h3>
                      <span className="text-sm text-muted-foreground">
                        {t("connectors.connectionCount", { count: pg.totalConnections })}
                      </span>
                    </div>
                  </div>
                  <span
                    className={cn(
                      "text-xs text-muted-foreground transition-transform duration-200",
                      expanded && "rotate-90",
                    )}
                  >
                    &#9654;
                  </span>
                </div>

                {expanded && (
                  <div className="mt-3 pt-3 border-t border-border flex flex-col gap-3">
                    {pg.orgs.map((og) => (
                      <div key={og.orgId}>
                        <div className="text-xs font-medium text-muted-foreground mb-2">
                          {og.orgName}
                        </div>
                        <div className="flex flex-col gap-2 pl-3 border-l-2 border-border">
                          {og.connections.map((conn) => (
                            <div
                              key={conn.connectionId}
                              className="flex items-center justify-between py-2 text-sm"
                            >
                              <div className="flex flex-col gap-0.5">
                                <span>
                                  {conn.profile.name}
                                  {conn.profile.isDefault && (
                                    <span className="ml-1.5 inline-flex items-center rounded-full border border-border bg-background px-2 py-px text-[0.7rem] text-muted-foreground">
                                      {t("profiles.default")}
                                    </span>
                                  )}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {conn.scopesGranted.length > 0 &&
                                    `${conn.scopesGranted.join(", ")} \u00b7 `}
                                  {conn.connectedAt && formatDateField(conn.connectedAt)}
                                </span>
                              </div>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => {
                                  if (
                                    confirm(
                                      t("connectors.deleteConfirm", {
                                        provider: pg.displayName,
                                        profile: conn.profile.name,
                                      }),
                                    )
                                  ) {
                                    disconnectMutation.mutate({
                                      provider: pg.providerId,
                                      connectionId: conn.connectionId,
                                    });
                                  }
                                }}
                                disabled={disconnectMutation.isPending}
                              >
                                {t("btn.disconnect")}
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
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
      <div className="text-sm font-medium text-muted-foreground mb-4">{t("profiles.title")}</div>

      <div className="rounded-lg border border-border bg-card p-5 mb-4">
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
            <div key={profile.id} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-3 mb-3">
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
                          <span className="ml-1.5 inline-flex items-center rounded-full border border-border bg-background px-2 py-px text-[0.7rem] text-muted-foreground">
                            {t("profiles.default")}
                          </span>
                        )}
                      </h3>
                      <span className="text-sm text-muted-foreground">
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
                      onClick={() => {
                        if (confirm(t("profiles.deleteConfirm", { name: profile.name }))) {
                          deleteProfile.mutate(profile.id);
                        }
                      }}
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
    </>
  );
}
