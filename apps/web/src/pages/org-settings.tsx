import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useOrg } from "../hooks/use-org";
import { useProviders } from "../hooks/use-providers";
import { useCreateProvider, useUpdateProvider, useDeleteProvider } from "../hooks/use-mutations";
import { useApiKeys, useRevokeApiKey } from "../hooks/use-api-keys";
import { ProviderFormModal } from "../components/provider-form-modal";
import { ApiKeyCreateModal } from "../components/api-key-create-modal";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { Spinner } from "../components/spinner";
import type {
  OrganizationMember,
  OrgRole,
  OrgInvitation,
  ProviderConfig,
  ApiKeyInfo,
} from "@appstrate/shared-types";

export function OrgSettingsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const { currentOrg, isOrgAdmin, isOrgOwner } = useOrg();
  const queryClient = useQueryClient();

  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get("tab");
  const validTabs = ["general", "members", "providers", "api-keys"] as const;
  type Tab = (typeof validTabs)[number];
  const [tab, setTab] = useState<Tab>(
    validTabs.includes(initialTab as Tab) ? (initialTab as Tab) : "general",
  );
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");

  // Members
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Providers
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [editProvider, setEditProvider] = useState<ProviderConfig | null>(null);
  const { data: providers, isLoading: providersLoading, error: providersError } = useProviders();
  const createProviderMutation = useCreateProvider();
  const updateProviderMutation = useUpdateProvider();
  const deleteProviderMutation = useDeleteProvider();

  // API Keys
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const { data: apiKeysData, isLoading: apiKeysLoading, error: apiKeysError } = useApiKeys();
  const revokeApiKeyMutation = useRevokeApiKey();

  const orgId = currentOrg?.id;

  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const {
    data: orgData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: async () => {
      return api<{ members: OrganizationMember[]; invitations: OrgInvitation[] }>(`/orgs/${orgId}`);
    },
    enabled: !!orgId,
  });

  const members = orgData?.members ?? [];
  const invitations = orgData?.invitations ?? [];

  // --- Mutations ---

  const updateNameMutation = useMutation({
    mutationFn: async (name: string) => {
      return api(`/orgs/${orgId}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orgs"] });
      setEditingName(false);
    },
    onError: (err: Error) => {
      alert(t("error.prefix", { message: err.message }));
    },
  });

  const addMemberMutation = useMutation({
    mutationFn: async ({ email, role }: { email: string; role: "member" | "admin" }) => {
      return api<{ invited?: boolean; added?: boolean; token?: string }>(`/orgs/${orgId}/members`, {
        method: "POST",
        body: JSON.stringify({ email, role }),
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      setInviteEmail("");
      setInviteRole("member");
      setInviteError(null);
      if (data?.invited && data.token) {
        setInviteLink(`${window.location.origin}/invite/${data.token}`);
        setLinkCopied(false);
      }
    },
    onError: (err: Error) => {
      setInviteError(err.message);
    },
  });

  const cancelInvitationMutation = useMutation({
    mutationFn: async (invitationId: string) => {
      return api(`/orgs/${orgId}/invitations/${invitationId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (err: Error) => {
      alert(t("error.prefix", { message: err.message }));
    },
  });

  const changeInvitationRoleMutation = useMutation({
    mutationFn: async ({
      invitationId,
      role,
    }: {
      invitationId: string;
      role: "member" | "admin";
    }) => {
      return api(`/orgs/${orgId}/invitations/${invitationId}`, {
        method: "PUT",
        body: JSON.stringify({ role }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (err: Error) => {
      alert(t("error.prefix", { message: err.message }));
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (userId: string) => {
      return api(`/orgs/${orgId}/members/${userId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (err: Error) => {
      alert(t("error.prefix", { message: err.message }));
    },
  });

  const changeRoleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: OrgRole }) => {
      return api(`/orgs/${orgId}/members/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ role }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (err: Error) => {
      alert(t("error.prefix", { message: err.message }));
    },
  });

  const deleteOrgMutation = useMutation({
    mutationFn: async () => {
      return api(`/orgs/${orgId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["orgs"] });
      navigate("/");
      // Force reload to reset org context
      window.location.reload();
    },
    onError: (err: Error) => {
      alert(t("error.prefix", { message: err.message }));
    },
  });

  // --- Guards ---

  if (!currentOrg) {
    return <EmptyState message={t("orgSettings.noOrg")} />;
  }

  if (!isOrgAdmin) {
    return <EmptyState message={t("orgSettings.adminOnly")} />;
  }

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  // --- Handlers ---

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    updateNameMutation.mutate(trimmed);
  };

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    setInviteError(null);
    const trimmed = inviteEmail.trim();
    if (!trimmed) return;
    addMemberMutation.mutate({ email: trimmed, role: inviteRole });
  };

  const handleRemove = (member: OrganizationMember) => {
    const label = member.displayName || member.email || member.userId;
    if (!confirm(t("orgSettings.removeMember", { name: label }))) return;
    removeMemberMutation.mutate(member.userId);
  };

  const handleRoleChange = (userId: string, role: OrgRole) => {
    changeRoleMutation.mutate({ userId, role });
  };

  const roleLabel: Record<OrgRole, string> = {
    owner: t("orgSettings.roleOwner"),
    admin: t("orgSettings.roleAdmin"),
    member: t("orgSettings.roleMember"),
  };

  return (
    <>
      <div className="page-header">
        <h2>{t("orgSettings.pageTitle")}</h2>
      </div>
      <div className="exec-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "general"}
          className={`tab ${tab === "general" ? "active" : ""}`}
          onClick={() => setTab("general")}
        >
          {t("orgSettings.tabGeneral")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "members"}
          className={`tab ${tab === "members" ? "active" : ""}`}
          onClick={() => setTab("members")}
        >
          {t("orgSettings.tabMembers", { count: members.length })}
        </button>
        <button
          role="tab"
          aria-selected={tab === "providers"}
          className={`tab ${tab === "providers" ? "active" : ""}`}
          onClick={() => setTab("providers")}
        >
          {t("orgSettings.tabProviders")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "api-keys"}
          className={`tab ${tab === "api-keys" ? "active" : ""}`}
          onClick={() => setTab("api-keys")}
        >
          {t("orgSettings.tabApiKeys")}
        </button>
      </div>

      {tab === "general" && (
        <>
          {/* Organisation info */}
          <div className="section-title">{t("orgSettings.orgTitle")}</div>
          <div className="service-card service-card-spaced">
            <div className="service-card-header">
              <div className="service-info">
                {editingName ? (
                  <form onSubmit={handleSaveName} className="org-edit-form">
                    <input
                      type="text"
                      className="inline-input"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={currentOrg.name}
                      autoFocus
                    />
                    <button
                      className="primary"
                      type="submit"
                      disabled={updateNameMutation.isPending}
                    >
                      {updateNameMutation.isPending ? <Spinner /> : t("btn.save")}
                    </button>
                    <button type="button" onClick={() => setEditingName(false)}>
                      {t("btn.cancel")}
                    </button>
                  </form>
                ) : (
                  <>
                    <h3>{currentOrg.name}</h3>
                    <span className="service-provider">{currentOrg.slug}</span>
                  </>
                )}
              </div>
              {isOrgOwner && !editingName && (
                <button
                  onClick={() => {
                    setNewName(currentOrg.name);
                    setEditingName(true);
                  }}
                >
                  {t("btn.edit")}
                </button>
              )}
            </div>
          </div>

          {/* Danger zone */}
          {isOrgOwner && (
            <>
              <div className="section-title section-title-mt-lg">{t("orgSettings.dangerZone")}</div>
              <div className="service-card service-card-danger">
                <div className="service-card-header service-card-header-flush">
                  <div className="service-info service-info-sm">
                    <h3>{t("orgSettings.deleteOrg")}</h3>
                    <span className="service-provider">{t("orgSettings.deleteOrgDesc")}</span>
                  </div>
                  <button
                    className="btn-danger"
                    disabled={deleteOrgMutation.isPending}
                    onClick={() => {
                      if (confirm(t("orgSettings.deleteConfirm", { name: currentOrg.name }))) {
                        deleteOrgMutation.mutate();
                      }
                    }}
                  >
                    {deleteOrgMutation.isPending ? t("orgSettings.deleting") : t("btn.delete")}
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {tab === "members" && (
        <>
          {/* Add member form */}
          <form onSubmit={handleInvite} className="invite-form">
            <div className="invite-form-field">
              <div className="invite-form-row">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => {
                    setInviteEmail(e.target.value);
                    setInviteError(null);
                  }}
                  placeholder="email@example.com"
                  required
                />
                <select
                  className="inline-select"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}
                >
                  <option value="member">{t("orgSettings.roleMember")}</option>
                  <option value="admin">{t("orgSettings.roleAdmin")}</option>
                </select>
              </div>
              {inviteError && <p className="form-error">{inviteError}</p>}
              {inviteLink && (
                <div className="invite-link-box">
                  <input
                    type="text"
                    readOnly
                    value={inviteLink}
                    className="invite-link-input"
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(inviteLink);
                      setLinkCopied(true);
                      setTimeout(() => setLinkCopied(false), 2000);
                    }}
                  >
                    {linkCopied ? t("btn.copied") : t("btn.copyLink")}
                  </button>
                  <button type="button" className="btn-dismiss" onClick={() => setInviteLink(null)}>
                    ✕
                  </button>
                </div>
              )}
            </div>
            <button className="primary" type="submit" disabled={addMemberMutation.isPending}>
              {addMemberMutation.isPending ? <Spinner /> : t("btn.add")}
            </button>
          </form>

          {/* Member list */}
          <div className="services-grid">
            {members.map((member) => {
              const label = member.displayName || member.email || member.userId;
              const isOwner = member.role === "owner";

              return (
                <div key={member.userId} className="service-card">
                  <div className="service-card-header service-card-header-flush">
                    <div className="service-info service-info-sm">
                      <h3>{label}</h3>
                      {member.email && <span className="service-provider">{member.email}</span>}
                    </div>
                    <span
                      className={`badge ${isOwner ? "badge-running" : member.role === "admin" ? "badge-success" : "badge-pending"}`}
                    >
                      {roleLabel[member.role]}
                    </span>
                  </div>
                  {isOrgAdmin && !isOwner && (
                    <div className="service-card-actions service-card-actions-bordered">
                      {isOrgOwner && (
                        <select
                          className="inline-select"
                          value={member.role}
                          onChange={(e) =>
                            handleRoleChange(member.userId, e.target.value as OrgRole)
                          }
                          disabled={changeRoleMutation.isPending}
                        >
                          <option value="member">{t("orgSettings.roleMember")}</option>
                          <option value="admin">{t("orgSettings.roleAdmin")}</option>
                          <option value="owner">{t("orgSettings.roleOwner")}</option>
                        </select>
                      )}
                      <button
                        className="ml-auto"
                        onClick={() => handleRemove(member)}
                        disabled={removeMemberMutation.isPending}
                      >
                        {t("btn.remove")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pending invitations */}
          {invitations.length > 0 && (
            <>
              <div className="section-title section-title-mt">
                {t("orgSettings.pendingInvitations")}
              </div>
              <div className="services-grid">
                {invitations.map((inv) => (
                  <div key={inv.id} className="service-card">
                    <div className="service-card-header service-card-header-flush">
                      <div className="service-info service-info-sm">
                        <h3>{inv.email}</h3>
                        <span className="service-provider">
                          {inv.role === "admin"
                            ? t("orgSettings.roleAdmin")
                            : t("orgSettings.roleMember")}
                        </span>
                      </div>
                      <span className="badge badge-pending">{t("orgSettings.invited")}</span>
                    </div>
                    <div className="service-card-actions service-card-actions-bordered">
                      {isOrgOwner && (
                        <select
                          className="inline-select"
                          value={inv.role}
                          onChange={(e) =>
                            changeInvitationRoleMutation.mutate({
                              invitationId: inv.id,
                              role: e.target.value as "member" | "admin",
                            })
                          }
                          disabled={changeInvitationRoleMutation.isPending}
                        >
                          <option value="member">{t("orgSettings.roleMember")}</option>
                          <option value="admin">{t("orgSettings.roleAdmin")}</option>
                        </select>
                      )}
                      <CopyLinkButton token={inv.token} />
                      <button
                        className="ml-auto"
                        onClick={() => cancelInvitationMutation.mutate(inv.id)}
                        disabled={cancelInvitationMutation.isPending}
                      >
                        {t("btn.cancel")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {members.length === 0 && invitations.length === 0 && (
            <EmptyState
              message={t("orgSettings.noMembers")}
              hint={t("orgSettings.noMembersHint")}
              compact
            />
          )}
        </>
      )}

      {tab === "providers" && (
        <ProvidersTab
          providers={providers}
          isLoading={providersLoading}
          error={providersError}
          onCreate={() => {
            setEditProvider(null);
            setProviderModalOpen(true);
          }}
          onEdit={(p) => {
            setEditProvider(p);
            setProviderModalOpen(true);
          }}
          onDelete={(p) => {
            if (!confirm(t("providers.deleteConfirm", { name: p.displayName }))) return;
            deleteProviderMutation.mutate(p.id);
          }}
        />
      )}

      {tab === "api-keys" && (
        <ApiKeysTab
          apiKeys={apiKeysData}
          isLoading={apiKeysLoading}
          error={apiKeysError}
          onCreate={() => setApiKeyModalOpen(true)}
          onRevoke={(key) => {
            if (!confirm(t("apiKeys.revokeConfirm", { name: key.name }))) return;
            revokeApiKeyMutation.mutate(key.id);
          }}
        />
      )}

      <ProviderFormModal
        open={providerModalOpen}
        onClose={() => setProviderModalOpen(false)}
        provider={editProvider}
        isPending={createProviderMutation.isPending || updateProviderMutation.isPending}
        onSubmit={(data) => {
          if (editProvider) {
            updateProviderMutation.mutate(
              { id: editProvider.id, data },
              { onSuccess: () => setProviderModalOpen(false) },
            );
          } else {
            createProviderMutation.mutate(data, { onSuccess: () => setProviderModalOpen(false) });
          }
        }}
      />

      <ApiKeyCreateModal open={apiKeyModalOpen} onClose={() => setApiKeyModalOpen(false)} />
    </>
  );
}

function CopyLinkButton({ token }: { token: string }) {
  const { t } = useTranslation(["common"]);
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/invite/${token}`;

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? t("btn.copied") : t("btn.copyLink")}
    </button>
  );
}

function ProvidersTab({
  providers,
  isLoading,
  error,
  onCreate,
  onEdit,
  onDelete,
}: {
  providers: ProviderConfig[] | undefined;
  isLoading: boolean;
  error: Error | null;
  onCreate: () => void;
  onEdit: (p: ProviderConfig) => void;
  onDelete: (p: ProviderConfig) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const authModeLabel: Record<string, string> = {
    oauth2: t("providers.authMode.oauth2"),
    api_key: t("providers.authMode.apiKey"),
    basic: t("providers.authMode.basic"),
    custom: t("providers.authMode.custom"),
  };

  return (
    <>
      <div className="tab-toolbar">
        <button className="primary" onClick={onCreate}>
          {t("providers.addProvider")}
        </button>
      </div>

      {providers && providers.length > 0 ? (
        <div className="services-grid">
          {providers.map((p) => {
            const isBuiltIn = p.source === "built-in";
            return (
              <div key={p.id} className="service-card">
                <div className="service-card-header">
                  <div className="service-info">
                    <h3 className="provider-name">
                      {p.iconUrl && (
                        <img
                          src={p.iconUrl}
                          alt=""
                          className="provider-icon"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      )}
                      {p.displayName}
                    </h3>
                    <div className="provider-badges">
                      <span className="badge badge-pending">
                        {authModeLabel[p.authMode] ?? p.authMode}
                      </span>
                      {isBuiltIn && (
                        <span className="badge badge-dim">{t("providers.builtIn")}</span>
                      )}
                      {p.source === "custom" && (
                        <span className="badge badge-dim">{t("providers.custom")}</span>
                      )}
                      {p.usedByFlows != null && p.usedByFlows > 0 && (
                        <span className="badge badge-success">
                          {t("providers.usedByFlows", { count: p.usedByFlows })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {!isBuiltIn && (
                  <div className="service-card-actions service-card-actions-bordered service-card-actions-end">
                    <button onClick={() => onEdit(p)}>{t("btn.edit")}</button>
                    <button
                      onClick={() => onDelete(p)}
                      disabled={!!p.usedByFlows && p.usedByFlows > 0}
                      title={
                        p.usedByFlows && p.usedByFlows > 0
                          ? t("providers.cannotDeleteInUse")
                          : undefined
                      }
                    >
                      {t("btn.delete")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState message={t("providers.empty", { defaultValue: "No providers configured." })} />
      )}
    </>
  );
}

function ApiKeysTab({
  apiKeys,
  isLoading,
  error,
  onCreate,
  onRevoke,
}: {
  apiKeys: ApiKeyInfo[] | undefined;
  isLoading: boolean;
  error: Error | null;
  onCreate: () => void;
  onRevoke: (key: ApiKeyInfo) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const formatDate = (iso: string | null) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const isExpired = (expiresAt: string | null) =>
    expiresAt ? new Date(expiresAt) < new Date() : false;

  return (
    <>
      <div className="tab-toolbar">
        <a href="/api/docs" target="_blank" rel="noopener noreferrer" className="btn-link">
          {t("apiKeys.swaggerLink")}
        </a>
        <button className="primary" onClick={onCreate}>
          {t("apiKeys.createBtn")}
        </button>
      </div>

      {apiKeys && apiKeys.length > 0 ? (
        <div className="services-grid">
          {apiKeys.map((key) => {
            const expired = isExpired(key.expiresAt);
            return (
              <div key={key.id} className="service-card">
                <div className="service-card-header">
                  <div className="service-info">
                    <h3>{key.name}</h3>
                    <div className="provider-badges">
                      <span className="badge badge-dim">{key.keyPrefix}...</span>
                      {expired ? (
                        <span className="badge badge-failed">{t("apiKeys.expired")}</span>
                      ) : (
                        <span className="badge badge-success">{t("apiKeys.active")}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="service-card-body">
                  <span className="service-provider">
                    {key.expiresAt
                      ? t("apiKeys.expiresOn", { date: formatDate(key.expiresAt) })
                      : t("apiKeys.neverExpires")}
                  </span>
                  {key.lastUsedAt && (
                    <span className="service-provider">
                      {t("apiKeys.lastUsed", { date: formatDate(key.lastUsedAt) })}
                    </span>
                  )}
                  {key.createdByName && (
                    <span className="service-provider">
                      {t("apiKeys.createdByLabel", { name: key.createdByName })}
                    </span>
                  )}
                </div>
                <div className="service-card-actions service-card-actions-bordered service-card-actions-end">
                  <button onClick={() => onRevoke(key)}>{t("apiKeys.revoke")}</button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState message={t("apiKeys.empty")} hint={t("apiKeys.emptyHint")} compact />
      )}
    </>
  );
}
