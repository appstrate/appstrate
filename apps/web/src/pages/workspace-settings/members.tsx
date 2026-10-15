// SPDX-License-Identifier: Apache-2.0

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppWindow, Eye, Plus, Users } from "lucide-react";
import { toast } from "sonner";
import { ORG_ROLES_WITH_FULL_ACCESS } from "@appstrate/core/permissions";
import { Input } from "@appstrate/ui/components/input";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Field, FieldDescription, FieldGroup } from "@appstrate/ui/components/field";
import { Label } from "@appstrate/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { ApiError } from "../../api/client";
import { useInviteMember, useOrg, useOrgDetail } from "../../hooks/use-org";
import { useCanPreviewRole, usePermissions } from "../../hooks/use-permissions";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useModalParam } from "../../hooks/use-modal-param";
import { useCanReach } from "../../hooks/use-can-reach";
import {
  DEFAULT_SPACE_ROLE_VALUE,
  memberRoleValue,
  spaceRoleAssignment,
  spaceRoleDescription,
  useSpaceRoleOptions,
} from "../../hooks/use-roles";
import {
  useAddSpaceMember,
  useAssignSpaceRole,
  useRemoveSpaceMember,
  useSpaceMembers,
  type SpaceMemberObject,
} from "../../hooks/use-space-members";
import { useSpace } from "../../hooks/use-spaces";
import { ConfirmModal } from "../../components/confirm-modal";
import { CopyLinkButton } from "../../components/copy-link-button";
import { DataTable } from "../../components/data-table";
import { InvitationsTable } from "../../components/invitations-table";
import { Modal } from "../../components/modal";
import { FormModal } from "../../components/form-modal";
import type { MenuAction } from "../../lib/menu-action";
import { RetryAlert } from "../../components/retry-alert";
import { RoleCatalogState } from "../../components/role-catalog-state";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { SpaceRoleSelect } from "../../components/space-role-select";
import { ViewAsDialog } from "../../components/view-as-dialog";
import { EmptyState, EmptyStateAction } from "../../components/page-states";
import { useSpaceMemberColumns } from "./space-member-columns";
import { memberLabel } from "../../lib/members";
import { spaceMemberRemoval, spaceMembersPageDeeds } from "../org-settings/rbac-deeds";
import { errorMessage } from "../../lib/mutation-error";

/** Owners and admins reach every space by role; a space-member row adds nothing. */
const FULL_ACCESS_ORG_ROLES: ReadonlySet<string> = new Set(ORG_ROLES_WITH_FULL_ACCESS);

export function WorkspaceSettingsMembersPage() {
  const { t } = useTranslation(["settings", "common"]);
  const spaceId = useCurrentSpaceId();

  if (!spaceId) return <EmptyState message={t("spaces.noSpaceSelected")} icon={AppWindow} />;
  return <SpaceMembersTable key={spaceId} spaceId={spaceId} />;
}

function SpaceMembersTable({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const { currentOrg } = useOrg();
  const canRead = can("space-members:read");
  const { data, isLoading, error } = useSpaceMembers(spaceId, canRead);
  // Disabling a query does not remove previously cached rows after a role change.
  const members = canRead ? data : undefined;
  const {
    options: roleOptions,
    roles,
    rolesKnown,
    isLoading: rolesLoading,
    error: rolesError,
    refetch: refetchRoles,
  } = useSpaceRoleOptions(spaceId);
  const { data: space, error: spaceError, refetch: refetchSpace } = useSpace(spaceId);
  const [memberToRemove, setMemberToRemove] = useState<SpaceMemberObject | null>(null);
  // Both modals have an address: `?add-member` and `?view-as`.
  const addParam = useModalParam("addMember");
  const viewAsParam = useModalParam("viewAs");
  const canPreview = useCanPreviewRole();

  const assignRole = useAssignSpaceRole(roleOptions);
  const removeMember = useRemoveSpaceMember();

  const canInvite = can("space-members:invite");
  const canChangeRole = can("space-members:change-role");
  const canRemove = can("space-members:remove");
  // A guest invited from this page is ONE org invitation carrying this space;
  // it shows here, pending, from the same object the Users page lists — never
  // as a fake member row. Tokens are org invitation authority, so only that
  // permission fetches the list (the server returns [] to anyone else anyway).
  const canSeeInvitations = can("members:invite");
  const { data: orgDetail } = useOrgDetail({ enabled: canSeeInvitations });

  const defaultRoleName = t(`roles.preset.${space?.default_role}`);

  const remove = (member: SpaceMemberObject) => {
    removeMember.mutate(
      { params: { path: { id: spaceId, userId: member.userId } } },
      {
        onSuccess: (result) => {
          setMemberToRemove(null);
          toast.success(
            result.access_after === "implicit"
              ? t("spaceMembers.removedImplicit", {
                  name: memberLabel(member),
                  role: defaultRoleName,
                })
              : t("spaceMembers.removedNone", { name: memberLabel(member) }),
          );
        },
      },
    );
  };

  // Owners and admins reach every space through their org role; `space_members`
  // never holds them, so there is nothing to edit. For everyone else the
  // control writes through two routes with two guards: an explicit row is
  // PATCHed (`change-role`), an implicit member gets a row created (`invite`).
  const rolesReady = rolesKnown && !rolesError && !rolesLoading && roleOptions.length > 0;
  const columns = useSpaceMemberColumns({
    editable: (member) =>
      member.source !== "org_role" &&
      rolesReady &&
      (member.source === "explicit" ? canChangeRole : canInvite),
    roles,
    roleOptions,
    isChangingRole: assignRole.isPending,
    onChangeRole: (member, value) =>
      assignRole.assign({ spaceId, member, name: memberLabel(member) }, value),
    removal: (member) => spaceMemberRemoval(member, { canRemove, visibility: space?.visibility }),
    isRemoving: removeMember.isPending,
    removeDisabled: removeMember.isPending || !space || !!spaceError,
    onRemove: setMemberToRemove,
  });

  const explicitUserIds = new Set(
    (members ?? []).filter((m) => m.source === "explicit").map((m) => m.userId),
  );
  const removal =
    memberToRemove?.org_role === "member" && space?.visibility === "open"
      ? ({
          titleKey: "spaceMembers.resetRole",
          confirmKey: "spaceMembers.resetConfirm",
          variant: "default",
        } as const)
      : ({
          titleKey: "spaceMembers.removeAccess",
          confirmKey: "spaceMembers.removeConfirm",
          variant: "destructive",
        } as const);
  const canManageRoles = canInvite || canChangeRole;
  const deeds = spaceMembersPageDeeds({ canInvite, canPreview });
  const add: MenuAction = {
    id: "add",
    icon: Plus,
    testId: "add-space-member-button",
    label: t("spaceMembers.add"),
    onSelect: () => addParam.open(),
    hidden: !deeds.includes("add"),
  };
  const viewAs: MenuAction = {
    id: "view-as",
    icon: Eye,
    testId: "view-as-space-button",
    label: t("viewAs.trigger"),
    onSelect: () => viewAsParam.open(),
    hidden: !deeds.includes("view-as"),
  };

  return (
    <>
      <SettingsPageActions actions={[add, viewAs]} />

      <p className="text-muted-foreground mb-6 max-w-2xl text-sm leading-relaxed">
        {t("spaceMembers.accessHint")}
      </p>
      {canManageRoles && (
        <RoleCatalogState
          className="mb-4"
          pending={null}
          isLoading={rolesLoading}
          rolesKnown={rolesKnown}
          error={rolesError}
          refetch={() => void refetchRoles()}
          emptyMessage={roleOptions.length === 0 ? t("spaceMembers.noAssignableRoles") : null}
        />
      )}
      {canRemove && spaceError && (
        <RetryAlert
          className="mb-4"
          message={t("spaceMembers.spaceLoadError")}
          onRetry={() => void refetchSpace()}
        />
      )}

      {canRead && (
        <DataTable
          label={t("spaceMembers.tabTitle")}
          columns={columns}
          rows={members ?? []}
          rowKey={(member) => member.userId}
          isLoading={isLoading}
          failure={error}
          empty={
            <EmptyState
              message={t("spaceMembers.empty")}
              hint={t("spaceMembers.emptyHint")}
              icon={Users}
              compact
            >
              <EmptyStateAction action={add} />
            </EmptyState>
          }
        />
      )}

      {canSeeInvitations && currentOrg && (
        <InvitationsTable
          key={`${currentOrg.id}:${spaceId}`}
          orgId={currentOrg.id}
          spaceId={spaceId}
          invitations={orgDetail?.invitations ?? []}
        />
      )}

      {viewAsParam.value !== null && canPreview && (
        <ViewAsDialog spaceId={spaceId} onClose={viewAsParam.close} />
      )}

      <ConfirmModal
        open={memberToRemove !== null}
        onClose={() => {
          if (!removeMember.isPending) setMemberToRemove(null);
        }}
        title={t(removal.titleKey)}
        description={
          memberToRemove
            ? t(removal.confirmKey, { name: memberLabel(memberToRemove), role: defaultRoleName })
            : ""
        }
        confirmLabel={t(removal.titleKey)}
        variant={removal.variant}
        isPending={removeMember.isPending}
        onConfirm={() => {
          if (memberToRemove && space && !spaceError) remove(memberToRemove);
        }}
      />

      {canInvite && addParam.value !== null && (
        <AddSpaceMemberModal
          key={`${spaceId}:${addParam.value}`}
          onClose={addParam.close}
          spaceId={spaceId}
          orgId={currentOrg?.id}
          excludedUserIds={explicitUserIds}
        />
      )}
    </>
  );
}

function AddSpaceMemberModal({
  onClose,
  spaceId,
  orgId,
  excludedUserIds,
}: {
  onClose: () => void;
  spaceId: string;
  orgId: string | undefined;
  excludedUserIds: Set<string>;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const canManageInvitations = useCanReach()("/org-settings/members");
  const {
    options: roleOptions,
    roles,
    rolesKnown,
    isLoading: rolesLoading,
    error: rolesError,
    refetch: refetchRoles,
  } = useSpaceRoleOptions(spaceId);
  const addMember = useAddSpaceMember({ errorHandledByCaller: true });
  const { can } = usePermissions();
  const canInviteExternal = can("members:invite");
  const canReadDirectory = can("members:read");
  const [mode, setMode] = useState("existing");
  const invitingExternal = canInviteExternal && mode === "external";
  const selectingUser = canReadDirectory && !invitingExternal;
  const [invitationToken, setInvitationToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("");
  // `conflict`: the address already holds a pending invitation. The fix is to EDIT that
  // one (add this space), never a second token — the server refuses with 409.
  const [formError, setFormError] = useState<{ message: string; conflict: boolean } | null>(null);
  const inviteGuest = useInviteMember();
  const isPending = addMember.isPending || inviteGuest.isPending;

  const {
    data: orgData,
    isLoading: usersLoading,
    error: usersError,
    refetch: refetchUsers,
  } = useOrgDetail({ enabled: selectingUser });
  // Owners and admins reach every space through their org role, so adding one
  // as a space member grants nothing and the route refuses it (409).
  const candidates = (orgData?.members ?? []).filter(
    (m) => !FULL_ACCESS_ORG_ROLES.has(m.role) && !excludedUserIds.has(m.userId),
  );
  const effectiveRole =
    role ||
    (roleOptions.some((option) => option.value === DEFAULT_SPACE_ROLE_VALUE)
      ? DEFAULT_SPACE_ROLE_VALUE
      : (roleOptions[0]?.value ?? ""));
  const roleFieldLocked = rolesLoading || !!rolesError || roleOptions.length === 0 || isPending;
  const selectedRole = roles?.find((item) => memberRoleValue(item, roles) === effectiveRole);
  const roleDescription = selectedRole ? spaceRoleDescription(selectedRole, t) : null;
  const hasIdentity = selectingUser ? !!userId : !!email.trim();
  const canSubmit =
    hasIdentity &&
    roleOptions.some((option) => option.value === effectiveRole) &&
    !rolesLoading &&
    !rolesError &&
    !(selectingUser && (usersLoading || usersError)) &&
    !isPending;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setFormError(null);
    if (invitingExternal) {
      if (!orgId) return;
      inviteGuest.mutate(
        {
          params: { path: { orgId } },
          body: {
            email: email.trim(),
            role: "guest",
            space_assignments: [{ spaceId, ...spaceRoleAssignment(effectiveRole) }],
          },
        },
        {
          onSuccess: (invitation) => {
            setInvitationToken(invitation.token);
            toast.success(t("spaceMembers.invited", { email: email.trim() }));
          },
          onError: (err) => {
            if (err instanceof ApiError && err.code === "invitation_already_pending") {
              setFormError({
                message: t("spaceMembers.invitationPending", { email: email.trim() }),
                conflict: true,
              });
              return;
            }
            setFormError({ message: errorMessage(err), conflict: false });
          },
        },
      );
      return;
    }
    addMember.mutate(
      {
        params: { path: { id: spaceId } },
        body: {
          ...(canReadDirectory ? { userId } : { email: email.trim() }),
          ...spaceRoleAssignment(effectiveRole),
        },
      },
      {
        onSuccess: () => {
          const candidate = candidates.find((member) => member.userId === userId);
          toast.success(
            t("spaceMembers.added", {
              name: canReadDirectory ? (candidate ? memberLabel(candidate) : userId) : email.trim(),
              role: roleOptions.find((option) => option.value === effectiveRole)?.label,
            }),
          );
          onClose();
        },
        onError: (err) =>
          setFormError({
            message:
              err instanceof ApiError && err.code === "redundant_space_role"
                ? t("spaceMembers.redundantRole")
                : errorMessage(err),
            conflict: false,
          }),
      },
    );
  };

  if (invitationToken) {
    return (
      <Modal onClose={onClose} title={t("spaceMembers.addTitle")}>
        <div className="flex flex-col items-start gap-4">
          <p>{t("spaceMembers.invited", { email: email.trim() })}</p>
          <p className="text-muted-foreground text-sm">{t("spaceMembers.invitationLinkHint")}</p>
          <CopyLinkButton token={invitationToken} />
          {canManageInvitations && (
            <Link
              to="/org-settings/members"
              className="text-primary text-sm underline underline-offset-4"
            >
              {t("spaceMembers.manageInvitations")}
            </Link>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <FormModal
      onClose={onClose}
      title={t("spaceMembers.addTitle")}
      onSubmit={submit}
      isPending={isPending}
      submitLabel={t(invitingExternal ? "spaceMembers.inviteGuest" : "btn.add")}
      submitDisabled={!canSubmit}
    >
      <FieldGroup>
        {canInviteExternal && (
          <fieldset disabled={isPending} className="flex flex-col gap-3">
            <legend className="mb-3 text-sm font-medium">{t("spaceMembers.addMode")}</legend>
            <RadioGroup
              value={mode}
              onValueChange={(value) => {
                setMode(value);
                setFormError(null);
              }}
              disabled={isPending}
            >
              <Field orientation="horizontal">
                <RadioGroupItem id="space-member-existing" value="existing" />
                <Label htmlFor="space-member-existing">{t("spaceMembers.existingUser")}</Label>
              </Field>
              <Field orientation="horizontal">
                <RadioGroupItem id="space-member-external" value="external" />
                <Label htmlFor="space-member-external">{t("spaceMembers.externalGuest")}</Label>
              </Field>
            </RadioGroup>
            {invitingExternal && (
              <FieldDescription>{t("spaceMembers.externalHint")}</FieldDescription>
            )}
          </fieldset>
        )}
        {selectingUser ? (
          <Field data-disabled={usersLoading || !!usersError || isPending}>
            <Label htmlFor="space-member-user">{t("spaceMembers.userLabel")}</Label>
            {usersLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <Select
                value={userId}
                onValueChange={(value) => {
                  setUserId(value);
                  setFormError(null);
                }}
                disabled={!!usersError || isPending}
              >
                <SelectTrigger id="space-member-user">
                  <SelectValue placeholder={t("spaceMembers.userPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {candidates.map((member) => (
                      <SelectItem key={member.userId} value={member.userId}>
                        {memberLabel(member)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
            {usersError && (
              <RetryAlert
                message={t("spaceMembers.usersLoadError")}
                onRetry={() => void refetchUsers()}
              />
            )}
            {!usersLoading && !usersError && candidates.length === 0 && (
              <FieldDescription>{t("spaceMembers.noCandidates")}</FieldDescription>
            )}
          </Field>
        ) : (
          <Field data-invalid={!!formError} data-disabled={isPending}>
            <Label htmlFor="space-member-email">
              {t(invitingExternal ? "spaceMembers.guestEmailLabel" : "spaceMembers.emailLabel")}
            </Label>
            <Input
              id="space-member-email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              disabled={isPending}
              aria-invalid={!!formError}
              aria-describedby="space-member-email-hint"
              onChange={(event) => {
                setEmail(event.target.value);
                setFormError(null);
              }}
              onInvalid={() =>
                setFormError({ message: t("spaceMembers.emailInvalid"), conflict: false })
              }
              placeholder="email@example.com"
            />
            <FieldDescription id="space-member-email-hint">
              {t(invitingExternal ? "spaceMembers.externalEmailHint" : "spaceMembers.emailHint")}
            </FieldDescription>
          </Field>
        )}
        <Field data-disabled={roleFieldLocked}>
          <Label htmlFor="space-member-role">{t("spaceMembers.colRole")}</Label>
          <SpaceRoleSelect
            id="space-member-role"
            value={effectiveRole}
            options={roleOptions}
            fallbackLabel={t("orgSettings.assignmentUnavailableRole")}
            placeholder={t("spaceMembers.noAssignableRoles")}
            disabled={roleFieldLocked}
            loading={rolesLoading}
            onValueChange={(value) => {
              setRole(value);
              setFormError(null);
            }}
          />
          <RoleCatalogState
            pending={null}
            isLoading={rolesLoading}
            rolesKnown={rolesKnown}
            error={rolesError}
            refetch={() => void refetchRoles()}
            emptyMessage={roleOptions.length === 0 ? t("spaceMembers.noAssignableRoles") : null}
          />
          {!rolesLoading && !rolesError && roleDescription && (
            <FieldDescription>{roleDescription}</FieldDescription>
          )}
        </Field>
        {formError && (
          <Alert variant="destructive">
            <AlertDescription>
              <p>{formError.message}</p>
              {formError.conflict && canManageInvitations && (
                <Link to="/org-settings/members" className="underline underline-offset-4">
                  {t("spaceMembers.manageInvitations")}
                </Link>
              )}
            </AlertDescription>
          </Alert>
        )}
      </FieldGroup>
    </FormModal>
  );
}
