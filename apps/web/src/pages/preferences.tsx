import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useUpdateLanguage, useUpdateDisplayName } from "../hooks/use-profile";
import { useAuth } from "../hooks/use-auth";
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
import { LoadingState, ErrorState } from "../components/page-states";
import type { UserConnectionItem } from "@appstrate/shared-types";

export function PreferencesPage() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const updateLanguage = useUpdateLanguage();
  const [tab, setTab] = useState<"general" | "security" | "connectors" | "profiles">("general");

  return (
    <>
      <div className="page-header">
        <h2>{t("preferences.title")}</h2>
      </div>
      <div className="exec-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "general"}
          className={`tab ${tab === "general" ? "active" : ""}`}
          onClick={() => setTab("general")}
        >
          {t("preferences.tabGeneral")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "security"}
          className={`tab ${tab === "security" ? "active" : ""}`}
          onClick={() => setTab("security")}
        >
          {t("preferences.tabSecurity")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "connectors"}
          className={`tab ${tab === "connectors" ? "active" : ""}`}
          onClick={() => setTab("connectors")}
        >
          {t("preferences.tabConnectors")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "profiles"}
          className={`tab ${tab === "profiles" ? "active" : ""}`}
          onClick={() => setTab("profiles")}
        >
          {t("preferences.tabProfiles")}
        </button>
      </div>

      {tab === "general" && (
        <GeneralTab
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
      <div className="section-title">{t("preferences.language")}</div>
      <div className="service-card service-card-spaced">
        <div className="service-card-header service-card-header-flush">
          <div className="service-info">
            <select
              className="language-select"
              value={language}
              onChange={(e) => onLanguageChange(e.target.value)}
              disabled={languagePending}
            >
              <option value="fr">{t("preferences.langFr")}</option>
              <option value="en">{t("preferences.langEn")}</option>
            </select>
          </div>
        </div>
      </div>

      <div className="section-title">{t("preferences.account")}</div>
      <DisplayNameForm />
    </>
  );
}

function SecurityTab() {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <>
      <div className="section-title">{t("preferences.changePassword")}</div>
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
    <div className="service-card service-card-spaced">
      <form onSubmit={handleSubmit} className="form-compact">
        <div className="form-group">
          <label>{t("preferences.displayName")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSuccess("");
            }}
            maxLength={100}
          />
        </div>
        {success && <div className="form-success">{success}</div>}
        <button type="submit" className="primary" disabled={!canSubmit}>
          {updateDisplayName.isPending
            ? t("preferences.savingDisplayName")
            : t("preferences.saveDisplayName")}
        </button>
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
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (newPassword !== confirmPassword) {
      setError(t("preferences.passwordMismatch"));
      return;
    }

    setSubmitting(true);
    try {
      await updatePassword(currentPassword, newPassword);
      setSuccess(t("preferences.passwordChanged"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("login.error"));
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= 6 &&
    confirmPassword.length > 0 &&
    !submitting;

  return (
    <div className="service-card service-card-spaced">
      <form onSubmit={handleSubmit} className="form-compact">
        <div className="form-group">
          <label>{t("preferences.currentPassword")}</label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              setError("");
              setSuccess("");
            }}
            autoComplete="current-password"
          />
        </div>
        <div className="form-group">
          <label>{t("preferences.newPassword")}</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setError("");
              setSuccess("");
            }}
            minLength={6}
            autoComplete="new-password"
          />
        </div>
        <div className="form-group">
          <label>{t("preferences.confirmPassword")}</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setError("");
              setSuccess("");
            }}
            autoComplete="new-password"
          />
        </div>
        {error && <div className="form-error">{error}</div>}
        {success && <div className="form-success">{success}</div>}
        <button type="submit" className="primary" disabled={!canSubmit}>
          {submitting ? t("preferences.changingPassword") : t("preferences.changePassword")}
        </button>
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
      <div className="section-header">
        <div className="section-title">{t("connectors.myConnections")}</div>
        <ProfileSelector />
      </div>

      <div className="service-card service-card-spaced">
        <div className="connectors-intro">
          <p className="service-provider">
            {t("connectors.description")}{" "}
            <Link to="/connectors" className="link-inline">
              {t("connectors.connectMore")}
            </Link>
          </p>
          {totalConnections > 0 && (
            <button
              className="danger"
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
            </button>
          )}
        </div>
      </div>

      {providerIds.length === 0 ? (
        <div className="empty-state">
          <p>{t("connectors.noConnections")}</p>
          <p className="empty-hint">{t("connectors.noConnectionsHint")}</p>
        </div>
      ) : (
        <div className="services-grid">
          {providerIds.map((providerId) => {
            const conns = grouped[providerId];
            const info = userConns?.providerInfo[providerId];
            const expanded = expandedProviders.has(providerId);

            return (
              <div key={providerId} className="service-card">
                <div className="provider-group-header" onClick={() => toggleExpand(providerId)}>
                  <div className="service-card-header service-card-header-flush">
                    {info?.logo && (
                      <img
                        className="service-logo"
                        src={info.logo}
                        alt={info?.displayName ?? providerId}
                      />
                    )}
                    <div className="service-info">
                      <h3>{info?.displayName ?? providerId}</h3>
                      <span className="service-provider">
                        {t("connectors.connectionCount", { count: conns.length })}
                      </span>
                    </div>
                  </div>
                  <span className={`provider-group-toggle${expanded ? " expanded" : ""}`}>
                    &#9654;
                  </span>
                </div>

                {expanded && (
                  <div className="provider-group-connections">
                    {conns.map((conn) => (
                      <div key={conn.connectionId} className="connection-item">
                        <div className="connection-meta">
                          <span>
                            {conn.profile.name}
                            {conn.profile.isDefault && (
                              <span className="tag" style={{ marginLeft: "0.4rem" }}>
                                {t("profiles.default")}
                              </span>
                            )}
                          </span>
                          <span className="connection-details">
                            {t(`connectors.authMode.${conn.authMode}`, {
                              defaultValue: conn.authMode,
                            })}
                            {conn.scopesGranted.length > 0 && ` · ${conn.scopesGranted.join(", ")}`}
                            {conn.connectedAt && ` · ${formatDateField(conn.connectedAt)}`}
                          </span>
                          {conn.orgs?.length > 0 && (
                            <span className="connection-orgs">
                              {conn.orgs.map((org) => (
                                <span
                                  key={org.id}
                                  className={`badge ${org.status === "valid" ? "badge-success" : "badge-warning"}`}
                                  title={
                                    org.status === "valid"
                                      ? t("connectors.orgValid", { org: org.name })
                                      : t("connectors.orgNeedsReconnection", { org: org.name })
                                  }
                                >
                                  {org.name}
                                </span>
                              ))}
                            </span>
                          )}
                        </div>
                        <button
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
                                profileId: conn.profile.id,
                              });
                            }
                          }}
                          disabled={disconnectMutation.isPending}
                        >
                          {t("btn.disconnect")}
                        </button>
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
      <div className="section-title">{t("profiles.title")}</div>

      <div className="service-card service-card-spaced">
        <div className="form-compact form-inline">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("profiles.namePlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim() && !createProfile.isPending) handleCreate();
            }}
          />
          <button
            className="primary"
            onClick={handleCreate}
            disabled={!newName.trim() || createProfile.isPending}
          >
            {t("profiles.create")}
          </button>
        </div>
      </div>

      {profiles && profiles.length > 0 && (
        <div className="services-grid">
          {profiles.map((profile) => (
            <div key={profile.id} className="service-card">
              <div className="service-card-header">
                <div className="service-info">
                  {editingId === profile.id ? (
                    <div className="form-inline">
                      <input
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
                      <button
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
                      </button>
                      <button onClick={() => setEditingId(null)}>{t("btn.cancel")}</button>
                    </div>
                  ) : (
                    <>
                      <h3>
                        {profile.name}
                        {profile.isDefault && (
                          <span className="tag" style={{ marginLeft: "0.4rem" }}>
                            {t("profiles.default")}
                          </span>
                        )}
                      </h3>
                      <span className="service-provider">
                        {t("profiles.connections", { count: profile.connectionCount })}
                      </span>
                    </>
                  )}
                </div>
              </div>
              {editingId !== profile.id && (
                <div className="service-card-actions">
                  <button
                    onClick={() => {
                      setEditingId(profile.id);
                      setEditName(profile.name);
                    }}
                  >
                    {t("profiles.rename")}
                  </button>
                  {!profile.isDefault && (
                    <button
                      onClick={() => {
                        if (confirm(t("profiles.deleteConfirm", { name: profile.name }))) {
                          deleteProfile.mutate(profile.id);
                        }
                      }}
                      disabled={deleteProfile.isPending}
                    >
                      {t("profiles.delete")}
                    </button>
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
