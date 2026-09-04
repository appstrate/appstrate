// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { Plus, Users, X } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { useQueryClient } from "@tanstack/react-query";
import { getErrorMessage } from "@appstrate/core/errors";
import { $api, type components } from "../../api/client";
import { useOrg } from "../../hooks/use-org";
import { useAuth } from "../../hooks/use-auth";
import { usePermissions, roleI18nKey } from "../../hooks/use-permissions";
import { useSpaces } from "../../hooks/use-spaces";
import {
  DEFAULT_SPACE_ROLE_VALUE,
  spaceRoleAssignment,
  useSpaceRoleOptions,
  type SpaceRoleOption,
} from "../../hooks/use-roles";
import { ConfirmModal } from "../../components/confirm-modal";
import { CopyLinkButton } from "../../components/copy-link-button";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { Spinner } from "../../components/spinner";
import { toast } from "sonner";
import {
  ASSIGNABLE_ORG_ROLES,
  assignableRolesForMember,
  canRemoveMember,
  type AssignableOrgRole,
} from "@appstrate/shared-types";

type OrgMember = components["schemas"]["OrgMember"];
type SpaceAssignment = components["schemas"]["SpaceAssignment"];

/** One row of the invite form's space section, before it becomes wire shape. */
interface AssignmentDraft {
  space_id: string;
  /** Encoded role option — see `spaceRoleAssignment`. */
  role: string;
}

interface InviteFormValues {
  email: string;
  role: AssignableOrgRole;
  assignments: AssignmentDraft[];
}

/** `Space — Role` for a pending invitation's assignment list. */
function spaceLabel(
  assignment: SpaceAssignment,
  spaces: { id: string; name: string }[] | undefined,
  roleOptions: SpaceRoleOption[],
): string {
  const name = spaces?.find((s) => s.id === assignment.space_id)?.name ?? assignment.space_id;
  const value = assignment.preset_role
    ? `preset:${assignment.preset_role}`
    : `custom:${assignment.custom_role_id}`;
  const role = roleOptions.find((o) => o.value === value)?.label;
  return role ? `${name} — ${role}` : name;
}

function toSpaceAssignments(drafts: AssignmentDraft[]): SpaceAssignment[] {
  return drafts
    .filter((d) => d.space_id && d.role)
    .map((d) => ({ space_id: d.space_id, ...spaceRoleAssignment(d.role) }));
}

/**
 * Per-invite space memberships.
 *
 * `guest` has no implicit access anywhere, so the API refuses an empty list for
 * it (400) and refuses a non-empty one for `admin`, who already runs every
 * space — this field mirrors both rules rather than letting the user find out
 * on submit.
 */
function SpaceAssignmentsField({
  value,
  onChange,
  spaces,
  roleOptions,
  disabled,
}: {
  value: AssignmentDraft[];
  onChange: (next: AssignmentDraft[]) => void;
  spaces: { id: string; name: string }[];
  roleOptions: SpaceRoleOption[];
  disabled: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const taken = new Set(value.map((a) => a.space_id));
  const available = spaces.filter((s) => !taken.has(s.id));
  const defaultRole = DEFAULT_SPACE_ROLE_VALUE;

  return (
    <div className="space-y-2">
      <Label>{t("orgSettings.inviteSpacesLabel")}</Label>
      <p className="text-muted-foreground text-sm">{t("orgSettings.inviteSpacesHint")}</p>
      {value.map((assignment, index) => {
        const space = spaces.find((s) => s.id === assignment.space_id);
        return (
          <div key={assignment.space_id} className="flex items-center gap-2">
            <span className="flex-1 truncate text-sm">{space?.name ?? assignment.space_id}</span>
            <Select
              value={assignment.role}
              disabled={disabled}
              onValueChange={(role) =>
                onChange(value.map((a, i) => (i === index ? { ...a, role } : a)))
              }
            >
              <SelectTrigger
                className="w-[160px]"
                aria-label={t("orgSettings.inviteSpaceRoleAriaLabel", {
                  space: space?.name ?? assignment.space_id,
                })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label={t("orgSettings.inviteSpaceRemove")}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              <X size={16} />
            </Button>
          </div>
        );
      })}
      {available.length > 0 && (
        <Select
          value=""
          disabled={disabled}
          onValueChange={(spaceId) =>
            onChange([...value, { space_id: spaceId, role: defaultRole }])
          }
        >
          <SelectTrigger className="w-[220px]" aria-label={t("orgSettings.inviteSpaceAdd")}>
            <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <Plus size={14} />
              {t("orgSettings.inviteSpaceAdd")}
            </span>
          </SelectTrigger>
          <SelectContent>
            {available.map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

export function OrgSettingsMembersPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { currentOrg } = useOrg();
  const { user } = useAuth();
  const { can, orgRole } = usePermissions();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const { data: spaces } = useSpaces();
  const { options: roleOptions } = useSpaceRoleOptions();

  const canInvite = can("members:invite");
  const canChangeRole = can("members:change-role");

  const [confirmState, setConfirmState] = useState<{ label: string; id: string } | null>(null);

  const inviteForm = useForm<InviteFormValues>({
    defaultValues: { email: "", role: "member", assignments: [] },
  });
  const inviteRole = useWatch({ control: inviteForm.control, name: "role" });
  const inviteAssignments = useWatch({ control: inviteForm.control, name: "assignments" }) ?? [];
  // `admin` runs every space already; the API refuses assignments for it.
  const showAssignments = inviteRole !== "admin";

  const {
    data: orgData,
    isLoading,
    error,
  } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: !!orgId },
  );

  const members = orgData?.members ?? [];
  const invitations = orgData?.invitations ?? [];

  const invalidateOrg = () => {
    void queryClient.invalidateQueries({ queryKey: ["get", "/api/orgs/{orgId}"] });
  };

  // Polymorphic bare resource: the created member (has `userId`) or the
  // created invitation (has `id` + `token`).
  const addMemberMutation = $api.useMutation("post", "/api/orgs/{orgId}/members", {
    onSuccess: () => {
      invalidateOrg();
      inviteForm.reset();
    },
    onError: (err) => {
      inviteForm.setError("root", { message: getErrorMessage(err) });
    },
  });

  const cancelInvitationMutation = $api.useMutation(
    "delete",
    "/api/orgs/{orgId}/invitations/{invitationId}",
    {
      onSuccess: invalidateOrg,
      onError: (err) => toast.error(t("error.prefix", { message: getErrorMessage(err) })),
    },
  );

  const changeInvitationRoleMutation = $api.useMutation(
    "put",
    "/api/orgs/{orgId}/invitations/{invitationId}",
    {
      onSuccess: invalidateOrg,
      onError: (err) => toast.error(t("error.prefix", { message: getErrorMessage(err) })),
    },
  );

  const removeMemberMutation = $api.useMutation("delete", "/api/orgs/{orgId}/members/{userId}", {
    onSuccess: invalidateOrg,
    onError: (err) => toast.error(t("error.prefix", { message: getErrorMessage(err) })),
  });

  const changeRoleMutation = $api.useMutation("put", "/api/orgs/{orgId}/members/{userId}", {
    onSuccess: invalidateOrg,
    onError: (err) => toast.error(t("error.prefix", { message: getErrorMessage(err) })),
  });

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

  const handleInvite = (data: InviteFormValues) => {
    const trimmed = data.email.trim();
    if (!trimmed || !orgId) return;
    const assignments = data.role === "admin" ? [] : toSpaceAssignments(data.assignments);
    if (data.role === "guest" && assignments.length === 0) {
      inviteForm.setError("assignments", { message: t("orgSettings.inviteSpacesRequired") });
      return;
    }
    inviteForm.clearErrors("assignments");
    addMemberMutation.mutate({
      params: { path: { orgId } },
      body: { email: trimmed, role: data.role, space_assignments: assignments },
    });
  };

  const handleRemove = (member: OrgMember) => {
    const label = member.displayName || member.email || member.userId;
    setConfirmState({ label, id: member.userId });
  };

  const handleRoleChange = (userId: string, newRole: AssignableOrgRole) => {
    if (!orgId) return;
    changeRoleMutation.mutate({
      params: { path: { orgId, userId } },
      body: { role: newRole },
    });
  };

  return (
    <>
      {canInvite && (
        <form onSubmit={inviteForm.handleSubmit(handleInvite)} className="mb-6 space-y-4">
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <div className="flex gap-2">
                <Input
                  type="email"
                  aria-label={t("orgSettings.inviteEmailAriaLabel")}
                  {...inviteForm.register("email", { required: true })}
                  placeholder="email@example.com"
                />
                <Select
                  value={inviteRole}
                  onValueChange={(v) => inviteForm.setValue("role", v as AssignableOrgRole)}
                >
                  <SelectTrigger
                    className="w-[140px]"
                    aria-label={t("orgSettings.inviteRoleAriaLabel")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSIGNABLE_ORG_ROLES.map((r) => (
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
          </div>

          {showAssignments && (
            <>
              <SpaceAssignmentsField
                value={inviteAssignments}
                onChange={(next) => inviteForm.setValue("assignments", next)}
                spaces={spaces ?? []}
                roleOptions={roleOptions}
                disabled={addMemberMutation.isPending}
              />
              {inviteForm.formState.errors.assignments && (
                <p className="text-destructive text-sm">
                  {inviteForm.formState.errors.assignments.message}
                </p>
              )}
            </>
          )}
        </form>
      )}

      <div className="flex flex-col gap-3">
        {members.map((member) => {
          const label = member.displayName || member.email || member.userId;
          const isMemberOwner = member.role === "owner";
          const isSelf = member.userId === user?.id;
          const assignableRoles =
            orgRole && canChangeRole
              ? assignableRolesForMember({ actorRole: orgRole, targetRole: member.role, isSelf })
              : [];
          const canRemove =
            orgRole && can("members:remove")
              ? canRemoveMember({ actorRole: orgRole, targetRole: member.role, isSelf })
              : false;
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
              {(assignableRoles.length > 0 || canRemove) && (
                <div className="border-border mt-3 flex gap-2 border-t pt-3">
                  {assignableRoles.length > 0 && (
                    <Select
                      value={member.role}
                      onValueChange={(v) => handleRoleChange(member.userId, v as AssignableOrgRole)}
                      disabled={changeRoleMutation.isPending}
                    >
                      <SelectTrigger className="w-[140px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {assignableRoles.map((r) => (
                          <SelectItem key={r} value={r}>
                            {t(roleI18nKey(r))}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {canRemove && (
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
                    {inv.space_assignments.length > 0 && (
                      <p className="text-muted-foreground mt-1 text-xs">
                        {t("orgSettings.inviteSpacesSummary", {
                          spaces: inv.space_assignments
                            .map((a) => spaceLabel(a, spaces, roleOptions))
                            .join(", "),
                        })}
                      </p>
                    )}
                  </div>
                  <Badge variant="pending">{t("orgSettings.invited")}</Badge>
                </div>
                <div className="border-border mt-3 flex gap-2 border-t pt-3">
                  {canChangeRole && (
                    <Select
                      value={inv.role}
                      onValueChange={(v) => {
                        const nextRole = v as AssignableOrgRole;
                        // Same rule as the invite form: a guest has no
                        // implicit access, so the API refuses the change
                        // without at least one assignment (400).
                        if (nextRole === "guest" && inv.space_assignments.length === 0) {
                          toast.error(t("orgSettings.inviteSpacesRequired"));
                          return;
                        }
                        changeInvitationRoleMutation.mutate({
                          params: { path: { orgId: orgId ?? "", invitationId: inv.id } },
                          body: {
                            role: nextRole,
                            // `admin` may hold none; every other role keeps what
                            // the invitation already carries.
                            space_assignments: nextRole === "admin" ? [] : inv.space_assignments,
                          },
                        });
                      }}
                      disabled={changeInvitationRoleMutation.isPending}
                    >
                      <SelectTrigger
                        className="w-[140px]"
                        aria-label={t("orgSettings.inviteRoleAriaLabel")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSIGNABLE_ORG_ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {t(roleI18nKey(r))}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <CopyLinkButton token={inv.token} />
                  {canInvite && (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="ml-auto"
                      onClick={() =>
                        cancelInvitationMutation.mutate({
                          params: { path: { orgId: orgId ?? "", invitationId: inv.id } },
                        })
                      }
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
            removeMemberMutation.mutate(
              { params: { path: { orgId: orgId ?? "", userId: confirmState.id } } },
              { onSuccess: () => setConfirmState(null) },
            );
          }
        }}
      />
    </>
  );
}
