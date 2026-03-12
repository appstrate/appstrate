import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useOrg } from "../hooks/use-org";
import { useApiKeys, useRevokeApiKey } from "../hooks/use-api-keys";
import {
  useProxies,
  useCreateProxy,
  useUpdateProxy,
  useDeleteProxy,
  useSetDefaultProxy,
} from "../hooks/use-proxies";
import {
  useModels,
  useCreateModel,
  useUpdateModel,
  useDeleteModel,
  useSetDefaultModel,
} from "../hooks/use-models";
import { ProxyFormModal } from "../components/proxy-form-modal";
import { ModelFormModal } from "../components/model-form-modal";
import { PROVIDER_ICONS } from "../components/icons";
import { PROVIDER_PRESETS } from "../lib/model-presets";

import { ApiKeyCreateModal } from "../components/api-key-create-modal";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { Spinner } from "../components/spinner";
import type {
  OrganizationMember,
  OrgRole,
  OrgInvitation,
  ApiKeyInfo,
  OrgProxyInfo,
  OrgModelInfo,
} from "@appstrate/shared-types";

export function OrgSettingsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const { currentOrg, isOrgAdmin, isOrgOwner } = useOrg();
  const queryClient = useQueryClient();

  const validTabs = ["general", "members", "models", "proxies", "api-keys"] as const;
  type Tab = (typeof validTabs)[number];
  const [tab, setTab] = useTabWithHash<Tab>(validTabs, "general");
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");

  // Members
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Proxies
  const [proxyModalOpen, setProxyModalOpen] = useState(false);
  const [editProxy, setEditProxy] = useState<OrgProxyInfo | null>(null);
  const { data: proxies, isLoading: proxiesLoading, error: proxiesError } = useProxies();
  const createProxyMutation = useCreateProxy();
  const updateProxyMutation = useUpdateProxy();
  const deleteProxyMutation = useDeleteProxy();
  const setDefaultProxyMutation = useSetDefaultProxy();

  // Models
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [editModel, setEditModel] = useState<OrgModelInfo | null>(null);
  const { data: models, isLoading: modelsLoading, error: modelsError } = useModels();
  const createModelMutation = useCreateModel();
  const updateModelMutation = useUpdateModel();
  const deleteModelMutation = useDeleteModel();
  const setDefaultModelMutation = useSetDefaultModel();

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
    return (
      <EmptyState message={t("orgSettings.adminOnly")} icon={ShieldAlert}>
        <Link to="/">
          <Button variant="outline">{t("btn.back")}</Button>
        </Link>
      </EmptyState>
    );
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
      <div className="mb-6">
        <h2>{t("orgSettings.pageTitle")}</h2>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="mb-4">
          <TabsTrigger value="general">{t("orgSettings.tabGeneral")}</TabsTrigger>
          <TabsTrigger value="members">
            {t("orgSettings.tabMembers", { count: members.length })}
          </TabsTrigger>
          <TabsTrigger value="models">{t("models.tabTitle")}</TabsTrigger>
          <TabsTrigger value="proxies">{t("proxies.tabTitle")}</TabsTrigger>
          <TabsTrigger value="api-keys">{t("orgSettings.tabApiKeys")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "general" && (
        <>
          {/* Organisation info */}
          <div className="text-sm font-medium text-muted-foreground mb-4">
            {t("orgSettings.orgTitle")}
          </div>
          <div className="rounded-lg border border-border bg-card p-5 mb-4">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                {editingName ? (
                  <form onSubmit={handleSaveName} className="flex items-center gap-2">
                    <Input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={currentOrg.name}
                      autoFocus
                    />
                    <Button type="submit" disabled={updateNameMutation.isPending}>
                      {updateNameMutation.isPending ? <Spinner /> : t("btn.save")}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setEditingName(false)}>
                      {t("btn.cancel")}
                    </Button>
                  </form>
                ) : (
                  <>
                    <h3 className="text-[0.95rem] font-semibold">{currentOrg.name}</h3>
                    <span className="text-sm text-muted-foreground">{currentOrg.slug}</span>
                  </>
                )}
              </div>
              {isOrgOwner && !editingName && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setNewName(currentOrg.name);
                    setEditingName(true);
                  }}
                >
                  {t("btn.edit")}
                </Button>
              )}
            </div>
          </div>

          {/* Danger zone */}
          {isOrgOwner && (
            <>
              <div className="text-sm font-medium text-muted-foreground mb-4 mt-8">
                {t("orgSettings.dangerZone")}
              </div>
              <div className="rounded-lg border border-destructive bg-card p-5">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold">{t("orgSettings.deleteOrg")}</h3>
                    <span className="text-sm text-muted-foreground">
                      {t("orgSettings.deleteOrgDesc")}
                    </span>
                  </div>
                  <Button
                    variant="destructive"
                    disabled={deleteOrgMutation.isPending}
                    onClick={() => {
                      if (confirm(t("orgSettings.deleteConfirm", { name: currentOrg.name }))) {
                        deleteOrgMutation.mutate();
                      }
                    }}
                  >
                    {deleteOrgMutation.isPending ? t("orgSettings.deleting") : t("btn.delete")}
                  </Button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {tab === "members" && (
        <>
          {/* Add member form */}
          <form onSubmit={handleInvite} className="flex gap-2 mb-4 items-start">
            <div className="flex-1">
              <div className="flex gap-2">
                <Input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => {
                    setInviteEmail(e.target.value);
                    setInviteError(null);
                  }}
                  placeholder="email@example.com"
                  required
                />
                <Select
                  value={inviteRole}
                  onValueChange={(v) => setInviteRole(v as "member" | "admin")}
                >
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">{t("orgSettings.roleMember")}</SelectItem>
                    <SelectItem value="admin">{t("orgSettings.roleAdmin")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {inviteError && <p className="text-sm text-destructive mt-1">{inviteError}</p>}
              {inviteLink && (
                <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5">
                  <Input
                    type="text"
                    readOnly
                    value={inviteLink}
                    className="flex-1 border-none bg-transparent text-xs font-mono text-muted-foreground min-w-0"
                    onFocus={(e) => e.target.select()}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => {
                      navigator.clipboard.writeText(inviteLink);
                      setLinkCopied(true);
                      setTimeout(() => setLinkCopied(false), 2000);
                    }}
                  >
                    {linkCopied ? t("btn.copied") : t("btn.copyLink")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="px-1 py-0.5"
                    onClick={() => setInviteLink(null)}
                  >
                    &#10005;
                  </Button>
                </div>
              )}
            </div>
            <Button type="submit" disabled={addMemberMutation.isPending}>
              {addMemberMutation.isPending ? <Spinner /> : t("btn.add")}
            </Button>
          </form>

          {/* Member list */}
          <div className="flex flex-col gap-3">
            {members.map((member) => {
              const label = member.displayName || member.email || member.userId;
              const isOwner = member.role === "owner";

              return (
                <div key={member.userId} className="rounded-lg border border-border bg-card p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <h3 className="text-sm font-semibold">{label}</h3>
                      {member.email && (
                        <span className="text-sm text-muted-foreground">{member.email}</span>
                      )}
                    </div>
                    <Badge
                      variant={
                        isOwner ? "running" : member.role === "admin" ? "success" : "pending"
                      }
                    >
                      {roleLabel[member.role]}
                    </Badge>
                  </div>
                  {isOrgAdmin && !isOwner && (
                    <div className="mt-3 pt-3 border-t border-border flex gap-2">
                      {isOrgOwner && (
                        <Select
                          value={member.role}
                          onValueChange={(v) => handleRoleChange(member.userId, v as OrgRole)}
                          disabled={changeRoleMutation.isPending}
                        >
                          <SelectTrigger className="w-[140px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="member">{t("orgSettings.roleMember")}</SelectItem>
                            <SelectItem value="admin">{t("orgSettings.roleAdmin")}</SelectItem>
                            <SelectItem value="owner">{t("orgSettings.roleOwner")}</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                      <Button
                        variant="destructive"
                        size="sm"
                        className="ml-auto"
                        onClick={() => handleRemove(member)}
                        disabled={removeMemberMutation.isPending}
                      >
                        {t("btn.remove")}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pending invitations */}
          {invitations.length > 0 && (
            <>
              <div className="text-sm font-medium text-muted-foreground mb-4 mt-6">
                {t("orgSettings.pendingInvitations")}
              </div>
              <div className="flex flex-col gap-3">
                {invitations.map((inv) => (
                  <div key={inv.id} className="rounded-lg border border-border bg-card p-5">
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <h3 className="text-sm font-semibold">{inv.email}</h3>
                        <span className="text-sm text-muted-foreground">
                          {inv.role === "admin"
                            ? t("orgSettings.roleAdmin")
                            : t("orgSettings.roleMember")}
                        </span>
                      </div>
                      <Badge variant="pending">{t("orgSettings.invited")}</Badge>
                    </div>
                    <div className="mt-3 pt-3 border-t border-border flex gap-2">
                      {isOrgOwner && (
                        <Select
                          value={inv.role}
                          onValueChange={(v) =>
                            changeInvitationRoleMutation.mutate({
                              invitationId: inv.id,
                              role: v as "member" | "admin",
                            })
                          }
                          disabled={changeInvitationRoleMutation.isPending}
                        >
                          <SelectTrigger className="w-[140px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="member">{t("orgSettings.roleMember")}</SelectItem>
                            <SelectItem value="admin">{t("orgSettings.roleAdmin")}</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                      <CopyLinkButton token={inv.token} />
                      <Button
                        variant="destructive"
                        size="sm"
                        className="ml-auto"
                        onClick={() => cancelInvitationMutation.mutate(inv.id)}
                        disabled={cancelInvitationMutation.isPending}
                      >
                        {t("btn.cancel")}
                      </Button>
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

      {tab === "models" && (
        <ModelsTab
          models={models}
          isLoading={modelsLoading}
          error={modelsError}
          onCreate={() => {
            setEditModel(null);
            setModelModalOpen(true);
          }}
          onEdit={(m) => {
            setEditModel(m);
            setModelModalOpen(true);
          }}
          onDelete={(m) => {
            if (!confirm(t("models.deleteConfirm", { label: m.label }))) return;
            deleteModelMutation.mutate(m.id);
          }}
          onSetDefault={(m) => setDefaultModelMutation.mutate(m.id)}
          onRemoveDefault={() => setDefaultModelMutation.mutate(null)}
        />
      )}

      {tab === "proxies" && (
        <ProxiesTab
          proxies={proxies}
          isLoading={proxiesLoading}
          error={proxiesError}
          onCreate={() => {
            setEditProxy(null);
            setProxyModalOpen(true);
          }}
          onEdit={(p) => {
            setEditProxy(p);
            setProxyModalOpen(true);
          }}
          onDelete={(p) => {
            if (!confirm(t("proxies.deleteConfirm", { label: p.label }))) return;
            deleteProxyMutation.mutate(p.id);
          }}
          onSetDefault={(p) => setDefaultProxyMutation.mutate(p.id)}
          onRemoveDefault={() => setDefaultProxyMutation.mutate(null)}
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

      <ApiKeyCreateModal open={apiKeyModalOpen} onClose={() => setApiKeyModalOpen(false)} />

      <ProxyFormModal
        open={proxyModalOpen}
        onClose={() => setProxyModalOpen(false)}
        proxy={editProxy}
        isPending={createProxyMutation.isPending || updateProxyMutation.isPending}
        onSubmit={(data) => {
          if (editProxy) {
            updateProxyMutation.mutate(
              { id: editProxy.id, data },
              { onSuccess: () => setProxyModalOpen(false) },
            );
          } else {
            createProxyMutation.mutate(data, { onSuccess: () => setProxyModalOpen(false) });
          }
        }}
      />

      <ModelFormModal
        open={modelModalOpen}
        onClose={() => setModelModalOpen(false)}
        model={editModel}
        isPending={createModelMutation.isPending || updateModelMutation.isPending}
        onSubmit={(data) => {
          if (editModel) {
            updateModelMutation.mutate(
              { id: editModel.id, data },
              { onSuccess: () => setModelModalOpen(false) },
            );
          } else {
            createModelMutation.mutate(data, { onSuccess: () => setModelModalOpen(false) });
          }
        }}
      />
    </>
  );
}

function CopyLinkButton({ token }: { token: string }) {
  const { t } = useTranslation(["common"]);
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/invite/${token}`;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? t("btn.copied") : t("btn.copyLink")}
    </Button>
  );
}

function ProxiesTab({
  proxies,
  isLoading,
  error,
  onCreate,
  onEdit,
  onDelete,
  onSetDefault,
  onRemoveDefault,
}: {
  proxies: OrgProxyInfo[] | undefined;
  isLoading: boolean;
  error: Error | null;
  onCreate: () => void;
  onEdit: (p: OrgProxyInfo) => void;
  onDelete: (p: OrgProxyInfo) => void;
  onSetDefault: (p: OrgProxyInfo) => void;
  onRemoveDefault: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <>
      <div className="rounded-lg border border-border bg-card p-5 mb-4">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("proxies.description")}</p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 mb-4">
        <Button onClick={onCreate}>{t("proxies.add")}</Button>
      </div>

      {proxies && proxies.length > 0 ? (
        <div className="flex flex-col gap-3">
          {proxies.map((p) => {
            const isBuiltIn = p.source === "built-in";
            return (
              <div key={p.id} className="rounded-lg border border-border bg-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex-1">
                    <h3 className="text-[0.95rem] font-semibold">{p.label}</h3>
                    <span className="text-sm text-muted-foreground">{p.urlPrefix}</span>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {p.isDefault && <Badge variant="success">{t("proxies.default")}</Badge>}
                      {isBuiltIn && (
                        <Badge variant="secondary" className="opacity-60">
                          {t("proxies.builtIn")}
                        </Badge>
                      )}
                      {!isBuiltIn && (
                        <Badge variant="secondary" className="opacity-60">
                          {p.enabled ? t("proxies.enabled") : t("proxies.disabled")}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-border flex gap-2 justify-end">
                  {p.isDefault && !isBuiltIn && (
                    <Button variant="outline" size="sm" onClick={onRemoveDefault}>
                      {t("proxies.removeDefault")}
                    </Button>
                  )}
                  {!p.isDefault && !isBuiltIn && (
                    <Button variant="outline" size="sm" onClick={() => onSetDefault(p)}>
                      {t("proxies.setDefault")}
                    </Button>
                  )}
                  {!isBuiltIn && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => onEdit(p)}>
                        {t("proxies.edit")}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => onDelete(p)}>
                        {t("proxies.delete")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState message={t("proxies.empty")} compact>
          <Button onClick={onCreate}>{t("proxies.add")}</Button>
        </EmptyState>
      )}
    </>
  );
}

function ModelsTab({
  models,
  isLoading,
  error,
  onCreate,
  onEdit,
  onDelete,
  onSetDefault,
  onRemoveDefault,
}: {
  models: OrgModelInfo[] | undefined;
  isLoading: boolean;
  error: Error | null;
  onCreate: () => void;
  onEdit: (m: OrgModelInfo) => void;
  onDelete: (m: OrgModelInfo) => void;
  onSetDefault: (m: OrgModelInfo) => void;
  onRemoveDefault: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <>
      <div className="rounded-lg border border-border bg-card p-5 mb-4">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("models.description")}</p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 mb-4">
        <Button onClick={onCreate}>{t("models.add")}</Button>
      </div>

      {models && models.length > 0 ? (
        <div className="flex flex-col gap-3">
          {models.map((m) => {
            const isBuiltIn = m.source === "built-in";
            const provider = PROVIDER_PRESETS.find(
              (p) => p.api === m.api && p.baseUrl === m.baseUrl,
            );
            const ProviderIcon = provider ? PROVIDER_ICONS[provider.id] : undefined;
            return (
              <div key={m.id} className="rounded-lg border border-border bg-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  {ProviderIcon && <ProviderIcon className="size-5" />}
                  <div className="flex-1">
                    <h3 className="text-[0.95rem] font-semibold">{m.label}</h3>
                    <span className="text-sm text-muted-foreground">
                      {m.api} / {m.modelId}
                    </span>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {m.isDefault && <Badge variant="success">{t("models.default")}</Badge>}
                      {isBuiltIn && (
                        <Badge variant="secondary" className="opacity-60">
                          {t("models.builtIn")}
                        </Badge>
                      )}
                      {!isBuiltIn && (
                        <Badge variant="secondary" className="opacity-60">
                          {m.enabled ? t("models.enabled") : t("models.disabled")}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-border flex gap-2 justify-end">
                  {m.isDefault && !isBuiltIn && (
                    <Button variant="outline" size="sm" onClick={onRemoveDefault}>
                      {t("models.removeDefault")}
                    </Button>
                  )}
                  {!m.isDefault && !isBuiltIn && (
                    <Button variant="outline" size="sm" onClick={() => onSetDefault(m)}>
                      {t("models.setDefault")}
                    </Button>
                  )}
                  {!isBuiltIn && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => onEdit(m)}>
                        {t("models.edit")}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => onDelete(m)}>
                        {t("models.delete")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState message={t("models.empty")} compact>
          <Button onClick={onCreate}>{t("models.add")}</Button>
        </EmptyState>
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
    if (!iso) return "\u2014";
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
      <div className="flex items-center justify-end gap-2 mb-4">
        <a
          href="/api/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="mr-auto text-primary text-sm no-underline hover:underline"
        >
          {t("apiKeys.swaggerLink")}
        </a>
        <Button onClick={onCreate}>{t("apiKeys.createBtn")}</Button>
      </div>

      {apiKeys && apiKeys.length > 0 ? (
        <div className="flex flex-col gap-3">
          {apiKeys.map((key) => {
            const expired = isExpired(key.expiresAt);
            return (
              <div key={key.id} className="rounded-lg border border-border bg-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex-1">
                    <h3 className="text-[0.95rem] font-semibold">{key.name}</h3>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      <Badge variant="secondary" className="opacity-60">
                        {key.keyPrefix}...
                      </Badge>
                      {expired ? (
                        <Badge variant="failed">{t("apiKeys.expired")}</Badge>
                      ) : (
                        <Badge variant="success">{t("apiKeys.active")}</Badge>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-1 mt-3">
                  <span className="text-sm text-muted-foreground">
                    {key.expiresAt
                      ? t("apiKeys.expiresOn", { date: formatDate(key.expiresAt) })
                      : t("apiKeys.neverExpires")}
                  </span>
                  {key.lastUsedAt && (
                    <span className="text-sm text-muted-foreground">
                      {t("apiKeys.lastUsed", { date: formatDate(key.lastUsedAt) })}
                    </span>
                  )}
                  {key.createdByName && (
                    <span className="text-sm text-muted-foreground">
                      {t("apiKeys.createdByLabel", { name: key.createdByName })}
                    </span>
                  )}
                </div>
                <div className="mt-3 pt-3 border-t border-border flex gap-2 justify-end">
                  <Button variant="destructive" size="sm" onClick={() => onRevoke(key)}>
                    {t("apiKeys.revoke")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState message={t("apiKeys.empty")} hint={t("apiKeys.emptyHint")} compact>
          <Button onClick={onCreate}>{t("apiKeys.createBtn")}</Button>
        </EmptyState>
      )}
    </>
  );
}
