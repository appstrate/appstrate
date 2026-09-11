// SPDX-License-Identifier: Apache-2.0

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AppWindow, Eye, Plus, Users } from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import { ORG_ROLES_WITH_FULL_ACCESS } from "@appstrate/core/permissions";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
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
import { $api, ApiError } from "../../../api/client";
import { useOrg } from "../../../hooks/use-org";
import { useCanPreviewRole, usePermissions } from "../../../hooks/use-permissions";
import { useCurrentSpaceId } from "../../../hooks/use-current-space";
import { useModalParam } from "../../../hooks/use-modal-param";
import {
  DEFAULT_SPACE_ROLE_VALUE,
  memberRoleValue,
  spaceRoleAssignment,
  spaceRoleDescription,
  useSpaceRoleOptions,
} from "../../../hooks/use-roles";
import {
  useAddSpaceMember,
  useRemoveSpaceMember,
  useUpdateSpaceMember,
  useSpaceMembers,
  type SpaceMemberObject,
} from "../../../hooks/use-space-members";
import { useSpace } from "../../../hooks/use-spaces";
import { ConfirmModal } from "../../../components/confirm-modal";
import { CopyLinkButton } from "../../../components/copy-link-button";
import { DataTable } from "../../../components/data-table";
import { InvitationsTable } from "../../../components/invitations-table";
import { Modal } from "../../../components/modal";
import { PageActionsMenu } from "../../../components/page-actions-menu";
import { RoleCatalogState } from "../../../components/role-catalog-state";
import { SettingsPageActions } from "../../../components/settings/settings-page-actions";
import { SpaceRoleSelect } from "../../../components/space-role-select";
import { ViewAsDialog } from "../../../components/view-as-dialog";
import { ErrorState, EmptyState } from "../../../components/page-states";
import { Spinner } from "../../../components/spinner";
import { useSpaceMemberColumns } from "./space-member-columns";
import { spaceMemberRemoval, spaceMembersPageDeeds } from "../rbac-deeds";

/** Owners and admins reach every space by role; a space-member row adds nothing. */
const FULL_ACCESS_ORG_ROLES: ReadonlySet<string> = new Set(ORG_ROLES_WITH_FULL_ACCESS);

function memberLabel(member: SpaceMemberObject): string {
  return member.name || member.email || member.userId;
}

export function OrgSettingsSpaceMembersPage() {
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
  const addParam = useModalParam("add-member");
  const viewAsParam = useModalParam("view-as");
  const canPreview = useCanPreviewRole();

  const addMember = useAddSpaceMember();
  const updateMember = useUpdateSpaceMember();
  const removeMember = useRemoveSpaceMember();

  const canInvite = can("space-members:invite");
  const canChangeRole = can("space-members:change-role");
  const canRemove = can("space-members:remove");
  // A guest invited from this page is ONE org invitation carrying this space;
  // it shows here, pending, from the same object the Users page lists — never
  // as a fake member row. Tokens are org invitation authority, so only that
  // permission fetches the list (the server returns [] to anyone else anyway).
  const canSeeInvitations = can("members:invite");
  const { data: orgDetail } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: currentOrg?.id ?? "" } } },
    { enabled: canSeeInvitations && !!currentOrg?.id },
  );

  const onError = (err: unknown) =>
    toast.error(t("error.prefix", { message: getErrorMessage(err) }));

  /**
   * One control, two routes: an explicit row is PATCHed, an implicit member
   * (open space) has no row yet, so picking a role CREATES one. `PATCH` 404s
   * without a row, so the branch is the API's, not a nicety.
   */
  const changeRole = (member: SpaceMemberObject, value: string) => {
    const body = spaceRoleAssignment(value);
    const onSuccess = () =>
      toast.success(
        t("spaceMembers.roleUpdated", {
          name: memberLabel(member),
          role: roleOptions.find((option) => option.value === value)?.label ?? value,
        }),
      );
    if (member.source === "explicit") {
      updateMember.mutate(
        { params: { path: { id: spaceId, userId: member.userId } }, body },
        { onError, onSuccess },
      );
      return;
    }
    addMember.mutate(
      { params: { path: { id: spaceId } }, body: { userId: member.userId, ...body } },
      { onError, onSuccess },
    );
  };

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
                  role: t(`roles.preset.${space?.default_role}`),
                })
              : t("spaceMembers.removedNone", { name: memberLabel(member) }),
          );
        },
        onError,
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
    roleValue: (member) => memberRoleValue(member.role, roles) ?? `current:${member.role?.key}`,
    roleOptions,
    isChangingRole: updateMember.isPending || addMember.isPending,
    onChangeRole: changeRole,
    removal: (member) => spaceMemberRemoval(member, { canRemove, visibility: space?.visibility }),
    isRemoving: removeMember.isPending,
    removeDisabled: removeMember.isPending || !space || !!spaceError,
    onRemove: setMemberToRemove,
  });

  const explicitUserIds = new Set(
    (members ?? []).filter((m) => m.source === "explicit").map((m) => m.userId),
  );
  const removalRestoresDefault =
    memberToRemove?.org_role === "member" && space?.visibility === "open";
  const canManageRoles = canInvite || canChangeRole;
  const deeds = spaceMembersPageDeeds({ canInvite, canPreview });

  return (
    <>
      {deeds.length > 0 && (
        <SettingsPageActions>
          <PageActionsMenu>
            {deeds.includes("add") && (
              <DropdownMenuItem
                data-page-action="add"
                data-testid="add-space-member-button"
                onSelect={() => addParam.open()}
              >
                <Plus />
                {t("spaceMembers.add")}
              </DropdownMenuItem>
            )}
            {deeds.includes("view-as") && (
              <DropdownMenuItem
                data-page-action="view-as"
                data-testid="view-as-space-button"
                onSelect={() => viewAsParam.open()}
              >
                <Eye />
                {t("viewAs.trigger")}
              </DropdownMenuItem>
            )}
          </PageActionsMenu>
        </SettingsPageActions>
      )}

      <p className="text-muted-foreground mb-6 max-w-2xl text-sm leading-relaxed">
        {t("spaceMembers.accessHint")}
      </p>
      {canManageRoles && (
        <RoleCatalogState
          className="mb-4"
          isLoading={rolesLoading}
          rolesKnown={rolesKnown}
          error={rolesError}
          refetch={() => void refetchRoles()}
          emptyMessage={roleOptions.length === 0 ? t("spaceMembers.noAssignableRoles") : null}
        />
      )}
      {canRemove && spaceError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            <p>{t("spaceMembers.spaceLoadError")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void refetchSpace()}>
              {t("btn.retry", { ns: "common" })}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {canRead && (
        <DataTable
          label={t("spaceMembers.tabTitle")}
          columns={columns}
          rows={members ?? []}
          rowKey={(member) => member.userId}
          isLoading={isLoading}
          isError={Boolean(error)}
          error={<ErrorState message={getErrorMessage(error)} compact />}
          empty={
            <EmptyState
              message={t("spaceMembers.empty")}
              hint={t("spaceMembers.emptyHint")}
              icon={Users}
              compact
            />
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
        title={t(removalRestoresDefault ? "spaceMembers.resetRole" : "spaceMembers.removeAccess")}
        description={
          memberToRemove
            ? t(
                removalRestoresDefault ? "spaceMembers.resetConfirm" : "spaceMembers.removeConfirm",
                {
                  name: memberLabel(memberToRemove),
                  role: t(`roles.preset.${space?.default_role}`),
                },
              )
            : ""
        }
        confirmLabel={t(
          removalRestoresDefault ? "spaceMembers.resetRole" : "spaceMembers.removeAccess",
        )}
        variant={removalRestoresDefault ? "default" : "destructive"}
        isPending={removeMember.isPending}
        onConfirm={() => {
          if (memberToRemove && space && !spaceError) remove(memberToRemove);
        }}
      />

      <AddSpaceMemberModal
        key={`${spaceId}:${addParam.value}`}
        open={canInvite && addParam.value !== null}
        onClose={addParam.close}
        spaceId={spaceId}
        orgId={currentOrg?.id}
        excludedUserIds={explicitUserIds}
      />
    </>
  );
}

function AddSpaceMemberModal({
  open,
  onClose,
  spaceId,
  orgId,
  excludedUserIds,
}: {
  open: boolean;
  onClose: () => void;
  spaceId: string;
  orgId: string | undefined;
  excludedUserIds: Set<string>;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const {
    options: roleOptions,
    roles,
    rolesKnown,
    isLoading: rolesLoading,
    error: rolesError,
    refetch: refetchRoles,
  } = useSpaceRoleOptions(spaceId);
  const addMember = useAddSpaceMember();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const canInviteExternal = can("members:invite");
  const canReadDirectory = can("members:read");
  const [mode, setMode] = useState("existing");
  const invitingExternal = canInviteExternal && mode === "external";
  const selectingUser = canReadDirectory && !invitingExternal;
  const [invitationToken, setInvitationToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // The address already holds a pending invitation: the fix is to EDIT that
  // one (add this space), never a second token — the server refuses with 409.
  const [pendingConflict, setPendingConflict] = useState(false);
  const inviteGuest = $api.useMutation("post", "/api/orgs/{orgId}/members", {
    onSuccess: (invitation) => {
      setInvitationToken(invitation.token);
      void queryClient.invalidateQueries({ queryKey: ["get", "/api/orgs/{orgId}"] });
      toast.success(t("spaceMembers.invited", { email: email.trim() }));
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "invitation_already_pending") {
        setPendingConflict(true);
        setFormError(t("spaceMembers.invitationPending", { email: email.trim() }));
        return;
      }
      setFormError(getErrorMessage(err));
    },
  });
  const isPending = addMember.isPending || inviteGuest.isPending;

  const {
    data: orgData,
    isLoading: usersLoading,
    error: usersError,
    refetch: refetchUsers,
  } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: open && !!orgId && selectingUser },
  );
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
    setPendingConflict(false);
    if (invitingExternal) {
      if (!orgId) return;
      inviteGuest.mutate({
        params: { path: { orgId } },
        body: {
          email: email.trim(),
          role: "guest",
          space_assignments: [{ space_id: spaceId, ...spaceRoleAssignment(effectiveRole) }],
        },
      });
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
              name: canReadDirectory
                ? candidate?.displayName || candidate?.email || userId
                : email.trim(),
              role: roleOptions.find((option) => option.value === effectiveRole)?.label,
            }),
          );
          setUserId("");
          setEmail("");
          setRole("");
          onClose();
        },
        onError: (err) =>
          setFormError(
            err instanceof ApiError && err.code === "redundant_space_role"
              ? t("spaceMembers.redundantRole")
              : getErrorMessage(err),
          ),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!isPending) onClose();
      }}
      title={t("spaceMembers.addTitle")}
      actions={
        invitationToken ? (
          <Button type="button" onClick={onClose}>
            {t("btn.close", { ns: "common" })}
          </Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              {t("btn.cancel", { ns: "common" })}
            </Button>
            <Button type="submit" form="space-member-form" disabled={!canSubmit}>
              {isPending ? (
                <Spinner />
              ) : (
                t(invitingExternal ? "spaceMembers.inviteGuest" : "btn.add")
              )}
            </Button>
          </>
        )
      }
    >
      {invitationToken ? (
        <div className="flex flex-col items-start gap-4">
          <p>{t("spaceMembers.invited", { email: email.trim() })}</p>
          <p className="text-muted-foreground text-sm">{t("spaceMembers.invitationLinkHint")}</p>
          <CopyLinkButton token={invitationToken} />
          <Link
            to="/org-settings/members"
            className="text-primary text-sm underline underline-offset-4"
          >
            {t("spaceMembers.manageInvitations")}
          </Link>
        </div>
      ) : (
        <form id="space-member-form" onSubmit={submit}>
          <FieldGroup>
            {canInviteExternal && (
              <fieldset disabled={isPending} className="flex flex-col gap-3">
                <legend className="mb-3 text-sm font-medium">{t("spaceMembers.addMode")}</legend>
                <RadioGroup
                  value={mode}
                  onValueChange={(value) => {
                    setMode(value);
                    setFormError(null);
                    setPendingConflict(false);
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
                <Select
                  value={userId}
                  onValueChange={(value) => {
                    setUserId(value);
                    setFormError(null);
                  }}
                  disabled={usersLoading || !!usersError || isPending}
                >
                  <SelectTrigger id="space-member-user">
                    <SelectValue placeholder={t("spaceMembers.userPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {candidates.map((member) => (
                        <SelectItem key={member.userId} value={member.userId}>
                          {member.displayName || member.email || member.userId}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {usersLoading && (
                  <FieldDescription role="status">
                    {t("spaceMembers.usersLoading")}
                  </FieldDescription>
                )}
                {usersError && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      <p>{t("spaceMembers.usersLoadError")}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void refetchUsers()}
                      >
                        {t("btn.retry", { ns: "common" })}
                      </Button>
                    </AlertDescription>
                  </Alert>
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
                    setPendingConflict(false);
                  }}
                  onInvalid={() => setFormError(t("spaceMembers.emailInvalid"))}
                  placeholder="email@example.com"
                />
                <FieldDescription id="space-member-email-hint">
                  {t(
                    invitingExternal ? "spaceMembers.externalEmailHint" : "spaceMembers.emailHint",
                  )}
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
                onValueChange={(value) => {
                  setRole(value);
                  setFormError(null);
                }}
              />
              <RoleCatalogState
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
                  <p>{formError}</p>
                  {pendingConflict && (
                    <Link to="/org-settings/members" className="underline underline-offset-4">
                      {t("spaceMembers.manageInvitations")}
                    </Link>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </FieldGroup>
        </form>
      )}
    </Modal>
  );
}
