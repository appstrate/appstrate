import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { useTheme } from "../components/theme-provider";
import { useUpdateLanguage, useUpdateDisplayName } from "../hooks/use-profile";
import { useAuth } from "../hooks/use-auth";
import { useFormErrors } from "../hooks/use-form-errors";
import { useDisconnect, useDeleteAllConnections } from "../hooks/use-mutations";
import {
  useConnectionProfiles,
  useAllUserConnections,
  useCreateConnectionProfile,
  useRenameConnectionProfile,
  useDeleteConnectionProfile,
} from "../hooks/use-connection-profiles";
import { useCurrentProfileId } from "../hooks/use-current-profile";
import { ProfileSelector } from "../components/profile-selector";
import { formatDateField } from "../lib/markdown";
import { Unplug } from "lucide-react";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";

import type { UserConnectionItem } from "@appstrate/shared-types";

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
        onValueChange={(v) => setTab(v as "general" | "appearance" | "security" | "connectors" | "profiles")}
      >
        <TabsList className="mb-4">
          <TabsTrigger value="general">{t("preferences.tabGeneral")}</TabsTrigger>
          <TabsTrigger value="appearance">{t("preferences.tabAppearance")}</TabsTrigger>
          <TabsTrigger value="security">{t("preferences.tabSecurity")}</TabsTrigger>
          <TabsTrigger value="connectors">{t("preferences.tabConnectors")}</TabsTrigger>
          <TabsTrigger value="profiles">{t("preferences.tabProfiles")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "general" && (
        <GeneralTab
          language={i18n.language}
          onLanguageChange={(lng) => updateLanguage.mutate(lng)}
          languagePending={updateLanguage.isPending}
        />
      )}

      {tab === "appearance" && <AppearanceTab />}

      {tab === "security" && <SecurityTab />}

      {tab === "connectors" && <ConnectorsTab />}

      {tab === "profiles" && <ProfilesTab />}
    </>
  );
}

function GeneralTab({
  language,
  onLanguageChange,
  languagePending,
}: {
  language: string;
  onLanguageChange: (lng: string) => void;
  languagePending: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <>
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

      <div className="text-sm font-medium text-muted-foreground mb-4">
        {t("preferences.account")}
      </div>
      <DisplayNameForm />
    </>
  );
}

function AppearanceTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { theme, setTheme } = useTheme();

  return (
    <>
      <div className="text-sm font-medium text-muted-foreground mb-4">
        {t("preferences.theme")}
      </div>
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

function DisplayNameForm() {
  const { t } = useTranslation(["settings", "common"]);
  const { profile } = useAuth();
  const updateDisplayName = useUpdateDisplayName();
  const [name, setName] = useState(profile?.displayName ?? "");
  const [success, setSuccess] = useState("");

  const isDirty = name.trim() !== (profile?.displayName ?? "");
  const canSubmit = name.trim().length > 0 && isDirty && !updateDisplayName.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSuccess("");
    updateDisplayName.mutate(name.trim(), {
      onSuccess: () => {
        setSuccess(t("preferences.displayNameChanged"));
      },
    });
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 mb-4">
      <form onSubmit={handleSubmit} className="space-y-4 py-1">
        <div className="space-y-2">
          <Label>{t("preferences.displayName")}</Label>
          <Input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
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

function PasswordChangeForm() {
  const { t } = useTranslation(["settings", "common"]);
  const { updatePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [serverError, setServerError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const rules = useMemo(
    () => ({
      currentPassword: (v: string) => {
        if (!v) return t("validation.required", { ns: "common" });
        return undefined;
      },
      newPassword: (v: string) => {
        if (!v) return t("validation.required", { ns: "common" });
        if (v.length < 6) return t("validation.minLength", { ns: "common", min: 6 });
        return undefined;
      },
      confirmPassword: (v: string) => {
        if (!v) return t("validation.required", { ns: "common" });
        if (v !== newPassword) return t("validation.passwordMismatch", { ns: "common" });
        return undefined;
      },
    }),
    [t, newPassword],
  );

  const { errors, onBlur, validateAll, clearErrors, clearField } = useFormErrors(rules);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError("");
    setSuccess("");

    if (!validateAll({ currentPassword, newPassword, confirmPassword })) return;

    setSubmitting(true);
    try {
      await updatePassword(currentPassword, newPassword);
      setSuccess(t("preferences.passwordChanged"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      clearErrors();
    } catch (err: unknown) {
      setServerError(err instanceof Error ? err.message : t("login.error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 mb-4">
      <form onSubmit={handleSubmit} className="space-y-4 py-1">
        <div className="space-y-2">
          <Label>{t("preferences.currentPassword")}</Label>
          <Input
            type="password"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              clearField("currentPassword");
              setServerError("");
              setSuccess("");
            }}
            onBlur={() => onBlur("currentPassword", currentPassword)}
            autoComplete="current-password"
            aria-invalid={errors.currentPassword ? true : undefined}
            className={cn(errors.currentPassword && "border-destructive")}
          />
          {errors.currentPassword && (
            <p className="text-xs text-destructive">{errors.currentPassword}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label>{t("preferences.newPassword")}</Label>
          <Input
            type="password"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              clearField("newPassword");
              setServerError("");
              setSuccess("");
            }}
            onBlur={() => onBlur("newPassword", newPassword)}
            minLength={6}
            autoComplete="new-password"
            aria-invalid={errors.newPassword ? true : undefined}
            className={cn(errors.newPassword && "border-destructive")}
          />
          {errors.newPassword && <p className="text-xs text-destructive">{errors.newPassword}</p>}
        </div>
        <div className="space-y-2">
          <Label>{t("preferences.confirmPassword")}</Label>
          <Input
            type="password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              clearField("confirmPassword");
              setServerError("");
              setSuccess("");
            }}
            onBlur={() => onBlur("confirmPassword", confirmPassword)}
            autoComplete="new-password"
            aria-invalid={errors.confirmPassword ? true : undefined}
            className={cn(errors.confirmPassword && "border-destructive")}
          />
          {errors.confirmPassword && (
            <p className="text-xs text-destructive">{errors.confirmPassword}</p>
          )}
        </div>
        {serverError && <div className="text-sm text-destructive">{serverError}</div>}
        {success && <div className="text-sm text-success">{success}</div>}
        <Button type="submit" disabled={submitting}>
          {submitting ? t("preferences.changingPassword") : t("preferences.changePassword")}
        </Button>
      </form>
    </div>
  );
}

function groupByProvider(connections: UserConnectionItem[] | undefined) {
  if (!connections) return {};
  const grouped: Record<string, UserConnectionItem[]> = {};
  for (const conn of connections) {
    (grouped[conn.providerId] ??= []).push(conn);
  }
  return grouped;
}

function ConnectorsTab() {
  const { t } = useTranslation(["settings", "common"]);
  const profileId = useCurrentProfileId();
  const { data: userConns, isLoading } = useAllUserConnections();
  const disconnectMutation = useDisconnect();
  const deleteAllMutation = useDeleteAllConnections();

  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());

  const filteredConnections = useMemo(() => {
    if (!userConns?.connections) return undefined;
    if (!profileId) return userConns.connections;
    return userConns.connections.filter((c) => c.profile.id === profileId);
  }, [userConns, profileId]);

  const grouped = useMemo(() => groupByProvider(filteredConnections), [filteredConnections]);

  if (isLoading) return <LoadingState />;

  const toggleExpand = (providerId: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  };

  const providerIds = Object.keys(grouped);
  const totalConnections = filteredConnections?.length ?? 0;

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-medium text-muted-foreground">
          {t("connectors.myConnections")}
        </div>
        <ProfileSelector />
      </div>

      <div className="rounded-lg border border-border bg-card p-5 mb-4">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {t("connectors.description")}{" "}
            <Link to="/connectors" className="text-primary text-sm no-underline hover:underline">
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

      {providerIds.length === 0 ? (
        <EmptyState
          message={t("connectors.noConnections")}
          hint={t("connectors.noConnectionsHint")}
          icon={Unplug}
        >
          <Link to="/connectors">
            <Button variant="outline">{t("connectors.goToConnectors")}</Button>
          </Link>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {providerIds.map((providerId) => {
            const conns = grouped[providerId];
            const info = userConns?.providerInfo[providerId];
            const expanded = expandedProviders.has(providerId);

            return (
              <div key={providerId} className="rounded-lg border border-border bg-card p-5">
                <div
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => toggleExpand(providerId)}
                >
                  <div className="flex items-center gap-3">
                    {info?.logo && (
                      <img
                        className="h-8 w-8 rounded-md object-contain"
                        src={info.logo}
                        alt={info?.displayName ?? providerId}
                      />
                    )}
                    <div className="flex-1">
                      <h3 className="text-[0.95rem] font-semibold">
                        {info?.displayName ?? providerId}
                      </h3>
                      <span className="text-sm text-muted-foreground">
                        {t("connectors.connectionCount", { count: conns.length })}
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
                  <div className="mt-3 pt-3 border-t border-border flex flex-col gap-2">
                    {conns.map((conn) => (
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
                            {t(`connectors.authMode.${conn.authMode}`, {
                              defaultValue: conn.authMode,
                            })}
                            {conn.scopesGranted.length > 0 &&
                              ` \u00b7 ${conn.scopesGranted.join(", ")}`}
                            {conn.connectedAt && ` \u00b7 ${formatDateField(conn.connectedAt)}`}
                          </span>
                          {(() => {
                            const validOrgs = conn.orgs?.filter((o) => o.status === "valid") ?? [];
                            return validOrgs.length > 0 ? (
                              <span className="flex flex-wrap gap-1 mt-1">
                                {validOrgs.map((org) => (
                                  <Badge
                                    key={org.id}
                                    variant="success"
                                    title={t("connectors.orgValid", { org: org.name })}
                                  >
                                    {org.name}
                                  </Badge>
                                ))}
                              </span>
                            ) : (
                              <span className="flex flex-wrap gap-1 mt-1">
                                <Badge variant="secondary" title={t("connectors.unusedHint")}>
                                  {t("connectors.unused")}
                                </Badge>
                              </span>
                            );
                          })()}
                        </div>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => {
                            if (
                              confirm(
                                t("connectors.deleteConfirm", {
                                  provider: info?.displayName ?? providerId,
                                  profile: conn.profile.name,
                                }),
                              )
                            ) {
                              disconnectMutation.mutate({
                                provider: providerId,
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
