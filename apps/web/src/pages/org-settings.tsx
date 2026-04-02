// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { BrainCircuit, Building, CreditCard, Globe, KeyRound, Users } from "lucide-react";
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
import { useAppConfig } from "../hooks/use-app-config";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useOrg } from "../hooks/use-org";
import { usePermissions, roleI18nKey, INVITE_ROLES, ALL_ROLES } from "../hooks/use-permissions";
import {
  useProxies,
  useCreateProxy,
  useUpdateProxy,
  useDeleteProxy,
  useSetDefaultProxy,
  useTestProxy,
} from "../hooks/use-proxies";
import {
  useModels,
  useDeleteModel,
  useSetDefaultModel,
  useTestModel,
  useModelFormHandler,
} from "../hooks/use-models";
import {
  useProviderKeys,
  useCreateProviderKey,
  useUpdateProviderKey,
  useDeleteProviderKey,
  useTestProviderKey,
} from "../hooks/use-provider-keys";
import { useConnectionTest } from "../hooks/use-connection-test";
import { ProxyFormModal } from "../components/proxy-form-modal";
import { ModelFormModal } from "../components/model-form-modal";
import { ProviderKeyFormModal } from "../components/provider-key-form-modal";
import { PROVIDER_ICONS } from "../components/icons";
import { findProviderByApiAndBaseUrl } from "../lib/model-presets";

import { ConfirmModal } from "../components/confirm-modal";
import { CopyLinkButton } from "../components/copy-link-button";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { Spinner } from "../components/spinner";
import { useBilling, useCheckout, usePortal, getUsageBarColor } from "../hooks/use-billing";
import { PlanGrid } from "../components/plan-card";
import { OrgProfilesTab } from "../components/org-profiles-tab";
import { toast } from "sonner";
import type {
  OrganizationMember,
  OrgRole,
  OrgInvitation,
  OrgProxyInfo,
  OrgModelInfo,
  OrgProviderKeyInfo,
  TestResult,
} from "@appstrate/shared-types";

export function OrgSettingsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const { isOwner, isAdmin } = usePermissions();
  const queryClient = useQueryClient();

  const { features } = useAppConfig();

  const validTabs = [
    "general",
    "members",
    "profiles",
    ...(isAdmin && features.models ? ["models" as const] : []),
    ...(isAdmin ? ["proxies" as const] : []),
    ...(features.billing ? ["billing" as const] : []),
  ] as const;
  type Tab = "general" | "members" | "profiles" | "models" | "proxies" | "billing";
  const [tab, setTab] = useTabWithHash<Tab>(validTabs as readonly Tab[], "general");
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const [modelsSubTab, setModelsSubTab] = useState<"models-list" | "provider-keys">("models-list");
  const [confirmState, setConfirmState] = useState<{
    type: "removeMember" | "deleteOrg" | "deleteModel" | "deleteProviderKey" | "deleteProxy";
    label: string;
    id?: string;
  } | null>(null);

  // Members — invite form
  const inviteForm = useForm<{ email: string; role: "viewer" | "member" | "admin" }>({
    defaultValues: { email: "", role: "member" },
  });
  const inviteRole = useWatch({ control: inviteForm.control, name: "role" });

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
  const deleteModelMutation = useDeleteModel();
  const setDefaultModelMutation = useSetDefaultModel();
  const modelForm = useModelFormHandler({
    editModel,
    onSuccess: () => setModelModalOpen(false),
  });

  // Provider Keys
  const [pkModalOpen, setPkModalOpen] = useState(false);
  const [editPk, setEditPk] = useState<OrgProviderKeyInfo | null>(null);
  const { data: providerKeys, isLoading: pkLoading, error: pkError } = useProviderKeys();
  const createPkMutation = useCreateProviderKey();
  const updatePkMutation = useUpdateProviderKey();
  const deletePkMutation = useDeleteProviderKey();

  const orgId = currentOrg?.id;

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
      toast.error(t("error.prefix", { message: err.message }));
    },
  });

  const addMemberMutation = useMutation({
    mutationFn: async ({ email, role }: { email: string; role: "viewer" | "member" | "admin" }) => {
      return api<{ invited?: boolean; added?: boolean; token?: string }>(`/orgs/${orgId}/members`, {
        method: "POST",
        body: JSON.stringify({ email, role }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      inviteForm.reset();
    },
    onError: (err: Error) => {
      inviteForm.setError("root", { message: err.message });
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
      toast.error(t("error.prefix", { message: err.message }));
    },
  });

  const changeInvitationRoleMutation = useMutation({
    mutationFn: async ({
      invitationId,
      role,
    }: {
      invitationId: string;
      role: "viewer" | "member" | "admin";
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
      toast.error(t("error.prefix", { message: err.message }));
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
      toast.error(t("error.prefix", { message: err.message }));
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
      toast.error(t("error.prefix", { message: err.message }));
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
      toast.error(t("error.prefix", { message: err.message }));
    },
  });

  // --- Guards ---

  if (!isAdmin) return null;

  if (!currentOrg) {
    return <EmptyState message={t("orgSettings.noOrg")} icon={Building} />;
  }

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  // --- Handlers ---

  const handleSaveName = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    updateNameMutation.mutate(trimmed);
  };

  const handleInvite = (data: { email: string; role: "viewer" | "member" | "admin" }) => {
    const trimmed = data.email.trim();
    if (!trimmed) return;
    addMemberMutation.mutate({ email: trimmed, role: data.role });
  };

  const handleRemove = (member: OrganizationMember) => {
    const label = member.displayName || member.email || member.userId;
    setConfirmState({ type: "removeMember", label, id: member.userId });
  };

  const handleRoleChange = (userId: string, role: OrgRole) => {
    changeRoleMutation.mutate({ userId, role });
  };

  return (
    <>
      <PageHeader
        title={t("orgSettings.pageTitle")}
        emoji="⚙️"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("orgSettings.pageTitle") },
        ]}
      >
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mt-2">
          <TabsList>
            <TabsTrigger value="general">{t("orgSettings.tabGeneral")}</TabsTrigger>
            <TabsTrigger value="members">
              {t("orgSettings.tabMembers", { count: members.length })}
            </TabsTrigger>
            <TabsTrigger value="profiles">{t("orgSettings.tabProfiles")}</TabsTrigger>
            {isAdmin && features.models && (
              <TabsTrigger value="models">{t("models.tabTitle")}</TabsTrigger>
            )}
            {isAdmin && <TabsTrigger value="proxies">{t("proxies.tabTitle")}</TabsTrigger>}
            {features.billing && <TabsTrigger value="billing">{t("billing.tabTitle")}</TabsTrigger>}
          </TabsList>
        </Tabs>
      </PageHeader>

      {tab === "general" && (
        <>
          {/* Organisation info */}
          <div className="text-muted-foreground mb-4 text-sm font-medium">
            {t("orgSettings.orgTitle")}
          </div>
          <div className="border-border bg-card mb-4 rounded-lg border p-5">
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
                    <span className="text-muted-foreground text-sm">{currentOrg.slug}</span>
                  </>
                )}
              </div>
              {isAdmin && !editingName && (
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
          {isOwner && (
            <>
              <div className="text-muted-foreground mt-8 mb-4 text-sm font-medium">
                {t("orgSettings.dangerZone")}
              </div>
              <div className="border-destructive bg-card rounded-lg border p-5">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold">{t("orgSettings.deleteOrg")}</h3>
                    <span className="text-muted-foreground text-sm">
                      {t("orgSettings.deleteOrgDesc")}
                    </span>
                  </div>
                  <Button
                    variant="destructive"
                    disabled={deleteOrgMutation.isPending}
                    onClick={() => setConfirmState({ type: "deleteOrg", label: currentOrg.name })}
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
          {isAdmin && (
            <form
              onSubmit={inviteForm.handleSubmit(handleInvite)}
              className="mb-4 flex items-start gap-2"
            >
              <div className="flex-1">
                <div className="flex gap-2">
                  <Input
                    type="email"
                    {...inviteForm.register("email", { required: true })}
                    placeholder="email@example.com"
                  />
                  <Select
                    value={inviteRole}
                    onValueChange={(v) =>
                      inviteForm.setValue("role", v as "viewer" | "member" | "admin")
                    }
                  >
                    <SelectTrigger className="w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INVITE_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {t(roleI18nKey(r))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {inviteForm.formState.errors.root && (
                  <p className="text-destructive mt-1 text-sm">
                    {inviteForm.formState.errors.root.message}
                  </p>
                )}
              </div>
              <Button type="submit" disabled={addMemberMutation.isPending}>
                {addMemberMutation.isPending ? <Spinner /> : t("btn.add")}
              </Button>
            </form>
          )}

          {/* Member list */}
          <div className="flex flex-col gap-3">
            {members.map((member) => {
              const label = member.displayName || member.email || member.userId;
              const isMemberOwner = member.role === "owner";

              return (
                <div key={member.userId} className="border-border bg-card rounded-lg border p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <h3 className="text-sm font-semibold">{label}</h3>
                      {member.email && (
                        <span className="text-muted-foreground text-sm">{member.email}</span>
                      )}
                    </div>
                    <Badge
                      variant={
                        isMemberOwner ? "running" : member.role === "admin" ? "success" : "pending"
                      }
                    >
                      {t(roleI18nKey(member.role))}
                    </Badge>
                  </div>
                  {!isMemberOwner && (
                    <div className="border-border mt-3 flex gap-2 border-t pt-3">
                      {isOwner && (
                        <Select
                          value={member.role}
                          onValueChange={(v) => handleRoleChange(member.userId, v as OrgRole)}
                          disabled={changeRoleMutation.isPending}
                        >
                          <SelectTrigger className="w-[140px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ALL_ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {t(roleI18nKey(r))}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {isAdmin && (
                        <Button
                          variant="destructive"
                          size="sm"
                          className="ml-auto"
                          onClick={() => handleRemove(member)}
                          disabled={removeMemberMutation.isPending}
                        >
                          {t("btn.remove")}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pending invitations */}
          {invitations.length > 0 && (
            <>
              <div className="text-muted-foreground mt-6 mb-4 text-sm font-medium">
                {t("orgSettings.pendingInvitations")}
              </div>
              <div className="flex flex-col gap-3">
                {invitations.map((inv) => (
                  <div key={inv.id} className="border-border bg-card rounded-lg border p-5">
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <h3 className="text-sm font-semibold">{inv.email}</h3>
                        <span className="text-muted-foreground text-sm">
                          {t(roleI18nKey(inv.role))}
                        </span>
                      </div>
                      <Badge variant="pending">{t("orgSettings.invited")}</Badge>
                    </div>
                    <div className="border-border mt-3 flex gap-2 border-t pt-3">
                      {isOwner && (
                        <Select
                          value={inv.role}
                          onValueChange={(v) =>
                            changeInvitationRoleMutation.mutate({
                              invitationId: inv.id,
                              role: v as "viewer" | "member" | "admin",
                            })
                          }
                          disabled={changeInvitationRoleMutation.isPending}
                        >
                          <SelectTrigger className="w-[140px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {INVITE_ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {t(roleI18nKey(r))}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <CopyLinkButton token={inv.token} />
                      {isAdmin && (
                        <Button
                          variant="destructive"
                          size="sm"
                          className="ml-auto"
                          onClick={() => cancelInvitationMutation.mutate(inv.id)}
                          disabled={cancelInvitationMutation.isPending}
                        >
                          {t("btn.cancel")}
                        </Button>
                      )}
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
              icon={Users}
              compact
            />
          )}
        </>
      )}

      {tab === "profiles" && <OrgProfilesTab />}

      {tab === "models" && features.models && (
        <>
          <Tabs
            value={modelsSubTab}
            onValueChange={(v) => setModelsSubTab(v as "models-list" | "provider-keys")}
          >
            <TabsList className="mb-4">
              <TabsTrigger value="models-list">{t("models.tabTitle")}</TabsTrigger>
              {features.providerKeys && (
                <TabsTrigger value="provider-keys">{t("providerKeys.title")}</TabsTrigger>
              )}
            </TabsList>
          </Tabs>

          {modelsSubTab === "models-list" && (
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
                setConfirmState({ type: "deleteModel", label: m.label, id: m.id });
              }}
              onSetDefault={(m) => setDefaultModelMutation.mutate(m.id)}
              onRemoveDefault={() => setDefaultModelMutation.mutate(null)}
            />
          )}

          {modelsSubTab === "provider-keys" && features.providerKeys && (
            <ProviderKeysSection
              providerKeys={providerKeys}
              isLoading={pkLoading}
              error={pkError}
              onCreate={() => {
                setEditPk(null);
                setPkModalOpen(true);
              }}
              onEdit={(pk) => {
                setEditPk(pk);
                setPkModalOpen(true);
              }}
              onDelete={(pk) => {
                setConfirmState({ type: "deleteProviderKey", label: pk.label, id: pk.id });
              }}
            />
          )}
        </>
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
            setConfirmState({ type: "deleteProxy", label: p.label, id: p.id });
          }}
          onSetDefault={(p) => setDefaultProxyMutation.mutate(p.id)}
          onRemoveDefault={() => setDefaultProxyMutation.mutate(null)}
        />
      )}

      {tab === "billing" && features.billing && <BillingTab />}

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
        isPending={modelForm.isPending}
        onSubmit={modelForm.onSubmit}
      />

      <ProviderKeyFormModal
        open={pkModalOpen}
        onClose={() => setPkModalOpen(false)}
        providerKey={editPk}
        isPending={createPkMutation.isPending || updatePkMutation.isPending}
        onSubmit={(data) => {
          if (editPk) {
            updatePkMutation.mutate(
              { id: editPk.id, data },
              { onSuccess: () => setPkModalOpen(false) },
            );
          } else {
            createPkMutation.mutate(
              data as { label: string; api: string; baseUrl: string; apiKey: string },
              {
                onSuccess: () => setPkModalOpen(false),
              },
            );
          }
        }}
      />

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={
          confirmState?.type === "deleteOrg"
            ? t("orgSettings.deleteOrg")
            : t("btn.confirm", { ns: "common" })
        }
        description={
          confirmState?.type === "deleteOrg"
            ? t("orgSettings.deleteConfirm", { name: confirmState.label })
            : confirmState?.type === "removeMember"
              ? t("orgSettings.removeMember", { name: confirmState?.label })
              : confirmState?.type === "deleteModel"
                ? t("models.deleteConfirm", { label: confirmState?.label })
                : confirmState?.type === "deleteProviderKey"
                  ? t("providerKeys.deleteConfirm", { label: confirmState?.label })
                  : t("proxies.deleteConfirm", { label: confirmState?.label })
        }
        isPending={
          removeMemberMutation.isPending ||
          deleteOrgMutation.isPending ||
          deleteModelMutation.isPending ||
          deletePkMutation.isPending ||
          deleteProxyMutation.isPending
        }
        onConfirm={() => {
          if (!confirmState) return;
          const close = () => setConfirmState(null);
          switch (confirmState.type) {
            case "removeMember":
              removeMemberMutation.mutate(confirmState.id!, { onSuccess: close });
              break;
            case "deleteOrg":
              deleteOrgMutation.mutate();
              break;
            case "deleteModel":
              deleteModelMutation.mutate(confirmState.id!, { onSuccess: close });
              break;
            case "deleteProviderKey":
              deletePkMutation.mutate(confirmState.id!, { onSuccess: close });
              break;
            case "deleteProxy":
              deleteProxyMutation.mutate(confirmState.id!, { onSuccess: close });
              break;
          }
        }}
      />
    </>
  );
}

function TestResultSpan({
  result,
  successKey,
  failedKey,
}: {
  result: TestResult;
  successKey: string;
  failedKey: string;
}) {
  const { t } = useTranslation(["settings"]);
  return (
    <span className={`text-sm ${result.ok ? "text-green-500" : "text-destructive"}`}>
      {result.ok
        ? t(successKey, { latency: result.latency })
        : t(failedKey, { message: result.message })}
    </span>
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
  const testMutation = useTestProxy();
  const { testingId, testResults, handleTest } = useConnectionTest(testMutation);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <>
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button onClick={onCreate}>{t("proxies.add")}</Button>
      </div>

      {proxies && proxies.length > 0 ? (
        <div className="flex flex-col gap-3">
          {proxies.map((p) => {
            const isBuiltIn = p.source === "built-in";
            return (
              <div key={p.id} className="border-border bg-card rounded-lg border p-5">
                <div className="mb-3 flex items-center gap-3">
                  <div className="flex-1">
                    <h3 className="text-[0.95rem] font-semibold">{p.label}</h3>
                    <span className="text-muted-foreground text-sm">{p.urlPrefix}</span>
                    <div className="mt-1 flex flex-wrap gap-1.5">
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
                <div className="border-border mt-3 flex items-center justify-end gap-2 border-t pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTest(p.id)}
                    disabled={testingId === p.id}
                  >
                    {testingId === p.id ? <Spinner /> : t("proxies.test")}
                  </Button>
                  {testResults[p.id] && (
                    <TestResultSpan
                      result={testResults[p.id]!}
                      successKey="proxies.testSuccess"
                      failedKey="proxies.testFailed"
                    />
                  )}
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
        <EmptyState message={t("proxies.empty")} icon={Globe} compact>
          <Button onClick={onCreate}>{t("proxies.add")}</Button>
        </EmptyState>
      )}
    </>
  );
}

function ProviderKeysSection({
  providerKeys,
  isLoading,
  error,
  onCreate,
  onEdit,
  onDelete,
}: {
  providerKeys: OrgProviderKeyInfo[] | undefined;
  isLoading: boolean;
  error: Error | null;
  onCreate: () => void;
  onEdit: (pk: OrgProviderKeyInfo) => void;
  onDelete: (pk: OrgProviderKeyInfo) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestProviderKey();
  const { testingId, testResults, handleTest } = useConnectionTest(testMutation);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <div className="mb-8">
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button onClick={onCreate}>{t("providerKeys.add")}</Button>
      </div>

      {providerKeys && providerKeys.length > 0 ? (
        <div className="flex flex-col gap-3">
          {providerKeys.map((pk) => {
            const provider = findProviderByApiAndBaseUrl(pk.api, pk.baseUrl);
            const ProviderIcon = provider ? PROVIDER_ICONS[provider.id] : undefined;
            return (
              <div key={pk.id} className="border-border bg-card rounded-lg border p-5">
                <div className="mb-3 flex items-center gap-3">
                  {ProviderIcon && <ProviderIcon className="size-5" />}
                  <div className="flex-1">
                    <h3 className="text-[0.95rem] font-semibold">{pk.label}</h3>
                    <span className="text-muted-foreground text-sm">{pk.api}</span>
                  </div>
                </div>
                <div className="border-border mt-3 flex items-center justify-end gap-2 border-t pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTest(pk.id)}
                    disabled={testingId === pk.id}
                  >
                    {testingId === pk.id ? <Spinner /> : t("providerKeys.test")}
                  </Button>
                  {testResults[pk.id] && (
                    <TestResultSpan
                      result={testResults[pk.id]!}
                      successKey="providerKeys.testSuccess"
                      failedKey="providerKeys.testFailed"
                    />
                  )}
                  {pk.source === "custom" && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => onEdit(pk)}>
                        {t("providerKeys.edit")}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => onDelete(pk)}>
                        {t("providerKeys.delete")}
                      </Button>
                    </>
                  )}
                  {pk.source === "built-in" && (
                    <span className="text-muted-foreground text-xs">{t("models.builtIn")}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          message={t("providerKeys.empty")}
          hint={t("providerKeys.emptyHint")}
          icon={KeyRound}
          compact
        >
          <Button onClick={onCreate}>{t("providerKeys.add")}</Button>
        </EmptyState>
      )}
    </div>
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
  const testMutation = useTestModel();
  const { testingId, testResults, handleTest } = useConnectionTest(testMutation);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <>
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button onClick={onCreate}>{t("models.add")}</Button>
      </div>

      {models && models.length > 0 ? (
        <div className="flex flex-col gap-3">
          {models.map((m) => {
            const isBuiltIn = m.source === "built-in";
            const provider = findProviderByApiAndBaseUrl(m.api, m.baseUrl);
            const ProviderIcon = provider ? PROVIDER_ICONS[provider.id] : undefined;
            return (
              <div key={m.id} className="border-border bg-card rounded-lg border p-5">
                <div className="mb-3 flex items-center gap-3">
                  {ProviderIcon && <ProviderIcon className="size-5" />}
                  <div className="flex-1">
                    <h3 className="text-[0.95rem] font-semibold">{m.label}</h3>
                    <span className="text-muted-foreground text-sm">
                      {m.api} / {m.modelId}
                    </span>
                    <div className="mt-1 flex flex-wrap gap-1.5">
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
                <div className="border-border mt-3 flex items-center justify-end gap-2 border-t pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTest(m.id)}
                    disabled={testingId === m.id}
                  >
                    {testingId === m.id ? <Spinner /> : t("models.test")}
                  </Button>
                  {testResults[m.id] && (
                    <TestResultSpan
                      result={testResults[m.id]!}
                      successKey="models.testSuccess"
                      failedKey="models.testFailed"
                    />
                  )}
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
        <EmptyState message={t("models.empty")} icon={BrainCircuit} compact>
          <Button onClick={onCreate}>{t("models.add")}</Button>
        </EmptyState>
      )}
    </>
  );
}

// --- Billing Tab ---

const STATUS_I18N: Record<string, string> = {
  past_due: "billing.statusPastDue",
  unpaid: "billing.statusUnpaid",
  paused: "billing.statusPaused",
  canceling: "billing.statusCanceling",
  canceled: "billing.statusCanceled",
  active: "billing.statusActive",
  trialing: "billing.statusTrialing",
  none: "billing.noSubscription",
};

function BillingTab() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const { data: billing, isLoading, error } = useBilling();
  const checkoutMutation = useCheckout();
  const portalMutation = usePortal();

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!billing) {
    return <EmptyState message={t("billing.noAccount")} icon={CreditCard} compact />;
  }

  const dateLocale = i18n.language === "fr" ? "fr-FR" : "en-US";
  const formatBillingDate = (iso: string) =>
    new Date(iso).toLocaleDateString(dateLocale, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

  const statusLabel =
    billing.status === "canceling" && billing.periodEnd
      ? t("billing.statusCanceling", {
          date: formatBillingDate(billing.periodEnd),
        })
      : billing.status === "active" && billing.periodEnd
        ? t("billing.cycleReset", {
            date: formatBillingDate(billing.periodEnd),
          })
        : t(STATUS_I18N[billing.status] ?? "billing.noSubscription");

  const hasSubscription = billing.status !== "none";

  const handleUpgrade = (planId: string) => {
    checkoutMutation.mutate(
      { planId },
      {
        onSuccess: (url) => {
          window.location.href = url;
        },
        onError: (err: Error) => {
          toast.error(t("error.prefix", { ns: "common", message: err.message }));
        },
      },
    );
  };

  const handleManage = () => {
    portalMutation.mutate(undefined, {
      onSuccess: (url) => {
        window.location.href = url;
      },
      onError: (err: Error) => {
        toast.error(t("error.prefix", { ns: "common", message: err.message }));
      },
    });
  };

  return (
    <>
      {/* Current plan */}
      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-[0.95rem] font-semibold">
              {t("billing.currentPlan")}: {billing.plan.name}
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">{statusLabel}</p>
          </div>
          {hasSubscription ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleManage}
              disabled={portalMutation.isPending}
            >
              {t("billing.manage")}
            </Button>
          ) : billing.upgrades.length > 0 ? (
            <Button size="sm" onClick={() => handleUpgrade(billing.upgrades[0]!.id)}>
              {t("billing.upgrade")}
            </Button>
          ) : null}
        </div>

        {/* Usage bar */}
        <div className="mb-2">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t("billing.usage")}</span>
            <span className="font-medium">
              {billing.usagePercent}%
              <span className="text-muted-foreground ml-2 text-xs font-normal">
                (
                {t("billing.creditsCount", {
                  used: billing.creditsUsed,
                  quota: billing.creditQuota,
                })}
                )
              </span>
            </span>
          </div>
          <div className="bg-muted h-2 overflow-hidden rounded-full">
            <div
              className={`h-full rounded-full transition-all ${getUsageBarColor(billing.usagePercent)}`}
              style={{ width: `${Math.min(billing.usagePercent, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Warning banners */}
      {billing.status === "past_due" && (
        <div className="mb-4 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4 text-sm">
          <p className="font-medium text-yellow-600 dark:text-yellow-400">
            {t("billing.pastDueWarning")}
          </p>
          <p className="text-muted-foreground mt-1">{t("billing.pastDueDescription")}</p>
        </div>
      )}

      {billing.status === "canceling" && billing.periodEnd && (
        <div className="mb-4 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4 text-sm">
          <p className="font-medium text-yellow-600 dark:text-yellow-400">
            {t("billing.cancelingWarning", {
              date: formatBillingDate(billing.periodEnd),
            })}
          </p>
        </div>
      )}

      {/* Available plans */}
      {billing.plans.length > 0 && (
        <div className="border-border bg-card mb-4 rounded-lg border p-5">
          <h3 className="mb-3 text-[0.95rem] font-semibold">{t("billing.upgradePlans")}</h3>
          <PlanGrid
            plans={billing.plans}
            currentPlanId={billing.plan.id}
            upgradeIds={new Set(billing.upgrades.map((u) => u.id))}
            disabled={checkoutMutation.isPending}
            onSelect={handleUpgrade}
          />
        </div>
      )}
    </>
  );
}
