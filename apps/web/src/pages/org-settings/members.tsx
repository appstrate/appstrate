// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useOrg } from "../../hooks/use-org";
import { usePermissions, roleI18nKey, INVITE_ROLES, ALL_ROLES } from "../../hooks/use-permissions";
import { ConfirmModal } from "../../components/confirm-modal";
import { CopyLinkButton } from "../../components/copy-link-button";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { Spinner } from "../../components/spinner";
import { toast } from "sonner";
import type { OrganizationMember, OrgRole, OrgInvitation } from "@appstrate/shared-types";

export function OrgSettingsMembersPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { currentOrg } = useOrg();
  const { isOwner, isAdmin } = usePermissions();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const [confirmState, setConfirmState] = useState<{ label: string; id: string } | null>(null);

  const inviteForm = useForm<{ email: string; role: "viewer" | "member" | "admin" }>({
    defaultValues: { email: "", role: "member" },
  });
  const inviteRole = useWatch({ control: inviteForm.control, name: "role" });

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
      return api(`/orgs/${orgId}/invitations/${invitationId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (err: Error) => toast.error(t("error.prefix", { message: err.message })),
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
    onError: (err: Error) => toast.error(t("error.prefix", { message: err.message })),
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (userId: string) => {
      return api(`/orgs/${orgId}/members/${userId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (err: Error) => toast.error(t("error.prefix", { message: err.message })),
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
    onError: (err: Error) => toast.error(t("error.prefix", { message: err.message })),
  });

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const handleInvite = (data: { email: string; role: "viewer" | "member" | "admin" }) => {
    const trimmed = data.email.trim();
    if (!trimmed) return;
    addMemberMutation.mutate({ email: trimmed, role: data.role });
  };

  const handleRemove = (member: OrganizationMember) => {
    const label = member.displayName || member.email || member.userId;
    setConfirmState({ label, id: member.userId });
  };

  const handleRoleChange = (userId: string, role: OrgRole) => {
    changeRoleMutation.mutate({ userId, role });
  };

  return (
    <>
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

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={
          confirmState ? t("orgSettings.removeMember", { name: confirmState.label }) : ""
        }
        isPending={removeMemberMutation.isPending}
        onConfirm={() => {
          if (confirmState) {
            removeMemberMutation.mutate(confirmState.id, {
              onSuccess: () => setConfirmState(null),
            });
          }
        }}
      />
    </>
  );
}
