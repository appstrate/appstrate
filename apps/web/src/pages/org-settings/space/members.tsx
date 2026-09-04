// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AppWindow, Users } from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import { $api, ApiError } from "../../../api/client";
import { useOrg } from "../../../hooks/use-org";
import { usePermissions } from "../../../hooks/use-permissions";
import { useCurrentSpaceId } from "../../../hooks/use-current-space";
import {
  DEFAULT_SPACE_ROLE_VALUE,
  memberRoleValue,
  spaceRoleAssignment,
  spaceRoleLabel,
  useSpaceRoleOptions,
} from "../../../hooks/use-roles";
import {
  useAddSpaceMember,
  useRemoveSpaceMember,
  useUpdateSpaceMember,
  useSpaceMembers,
  type SpaceMemberObject,
} from "../../../hooks/use-space-members";
import { Modal } from "../../../components/modal";
import { LoadingState, ErrorState, EmptyState } from "../../../components/page-states";
import { Spinner } from "../../../components/spinner";

/** Badge tone per membership source — explicit rows are the editable ones. */
const SOURCE_VARIANT: Record<SpaceMemberObject["source"], "success" | "running" | "pending"> = {
  explicit: "success",
  org_role: "running",
  open_space: "pending",
};

function memberLabel(member: SpaceMemberObject): string {
  return member.name || member.email || member.userId;
}

export function OrgSettingsSpaceMembersPage() {
  const { t } = useTranslation(["settings", "common"]);
  const spaceId = useCurrentSpaceId();

  if (!spaceId) return <EmptyState message={t("spaces.noSpaceSelected")} icon={AppWindow} />;
  return <SpaceMembersTable spaceId={spaceId} />;
}

function SpaceMembersTable({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const { currentOrg } = useOrg();
  const { data: members, isLoading, error } = useSpaceMembers(spaceId);
  const { options: roleOptions, roles, rolesKnown } = useSpaceRoleOptions();
  const [addOpen, setAddOpen] = useState(false);

  const addMember = useAddSpaceMember();
  const updateMember = useUpdateSpaceMember();
  const removeMember = useRemoveSpaceMember();

  const canInvite = can("space-members:invite");
  const canChangeRole = can("space-members:change-role");
  const canRemove = can("space-members:remove");

  const onError = (err: unknown) =>
    toast.error(t("error.prefix", { message: getErrorMessage(err) }));

  /**
   * One control, two routes: an explicit row is PATCHed, an implicit member
   * (open space) has no row yet, so picking a role CREATES one. `PATCH` 404s
   * without a row, so the branch is the API's, not a nicety.
   */
  const changeRole = (member: SpaceMemberObject, value: string) => {
    const body = spaceRoleAssignment(value);
    if (member.source === "explicit") {
      updateMember.mutate(
        { params: { path: { id: spaceId, userId: member.userId } }, body },
        { onError },
      );
      return;
    }
    addMember.mutate(
      { params: { path: { id: spaceId } }, body: { userId: member.userId, ...body } },
      { onError },
    );
  };

  const remove = (member: SpaceMemberObject) => {
    removeMember.mutate(
      { params: { path: { id: spaceId, userId: member.userId } } },
      {
        onSuccess: (result) => {
          toast.success(
            result.access_after === "implicit"
              ? t("spaceMembers.removedImplicit", { name: memberLabel(member) })
              : t("spaceMembers.removedNone", { name: memberLabel(member) }),
          );
        },
        onError,
      },
    );
  };

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

  const explicitUserIds = new Set(
    (members ?? []).filter((m) => m.source === "explicit").map((m) => m.userId),
  );

  return (
    <>
      {canInvite && (
        <div className="mb-4 flex justify-end">
          <Button data-testid="add-space-member-button" onClick={() => setAddOpen(true)}>
            {t("spaceMembers.add")}
          </Button>
        </div>
      )}

      {!members || members.length === 0 ? (
        <EmptyState
          message={t("spaceMembers.empty")}
          hint={t("spaceMembers.emptyHint")}
          icon={Users}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("spaceMembers.colMember")}</TableHead>
              <TableHead>{t("spaceMembers.colSource")}</TableHead>
              <TableHead>{t("spaceMembers.colRole")}</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              // Owners and admins reach every space through their org role;
              // `space_members` never holds them, so there is nothing to edit.
              // For everyone else the control writes through two routes with
              // two guards: an explicit row is PATCHed (`change-role`), an
              // implicit member gets a row created (`invite`).
              const currentValue = memberRoleValue(member.role, roles);
              // A custom role the caller cannot resolve (no `roles:read`) has
              // no matching option — offering the preset list would silently
              // downgrade them on the next pick.
              const unresolvedCustomRole = member.role?.kind === "custom" && !rolesKnown;
              const editable =
                member.source !== "org_role" &&
                !unresolvedCustomRole &&
                (member.source === "explicit" ? canChangeRole : canInvite);
              return (
                <TableRow key={member.userId}>
                  <TableCell>
                    <span className="font-medium">{memberLabel(member)}</span>
                    {member.email && member.email !== memberLabel(member) && (
                      <span className="text-muted-foreground block text-xs">{member.email}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={SOURCE_VARIANT[member.source]}>
                      {t(`spaceMembers.source.${member.source}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {editable ? (
                      <Select
                        value={currentValue}
                        onValueChange={(v) => changeRole(member, v)}
                        disabled={updateMember.isPending || addMember.isPending}
                      >
                        <SelectTrigger
                          className="w-[180px]"
                          aria-label={t("spaceMembers.roleAriaLabel", {
                            name: memberLabel(member),
                          })}
                        >
                          <SelectValue placeholder={t("spaceMembers.noRole")} />
                        </SelectTrigger>
                        <SelectContent>
                          {roleOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-muted-foreground text-sm">
                        {spaceRoleLabel(member.role, t) ?? t("spaceMembers.noRole")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {member.source === "explicit" && canRemove && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => remove(member)}
                        disabled={removeMember.isPending}
                      >
                        {t("btn.remove")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <AddSpaceMemberModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
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
  const { options: roleOptions } = useSpaceRoleOptions();
  const addMember = useAddSpaceMember();
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const { data: orgData } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: open && !!orgId },
  );

  // Owners and admins already run every space (409 `redundant_space_role`),
  // and someone with an explicit row is edited from the table, not re-added.
  const candidates = (orgData?.members ?? []).filter(
    (m) => m.role !== "owner" && m.role !== "admin" && !excludedUserIds.has(m.userId),
  );

  const effectiveRole = role || DEFAULT_SPACE_ROLE_VALUE;

  const submit = () => {
    if (!userId || !effectiveRole) return;
    setFormError(null);
    addMember.mutate(
      {
        params: { path: { id: spaceId } },
        body: { userId, ...spaceRoleAssignment(effectiveRole) },
      },
      {
        onSuccess: () => {
          setUserId("");
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
      onClose={onClose}
      title={t("spaceMembers.addTitle")}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          <Button onClick={submit} disabled={!userId || addMember.isPending}>
            {addMember.isPending ? <Spinner /> : t("btn.add")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="space-member-user">{t("spaceMembers.userLabel")}</Label>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger id="space-member-user">
              <SelectValue placeholder={t("spaceMembers.userPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  {m.displayName || m.email || m.userId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {candidates.length === 0 && (
            <p className="text-muted-foreground text-sm">{t("spaceMembers.noCandidates")}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="space-member-role">{t("spaceMembers.colRole")}</Label>
          <Select value={effectiveRole} onValueChange={setRole}>
            <SelectTrigger id="space-member-role">
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
        </div>

        {formError && <p className="text-destructive text-sm">{formError}</p>}
      </div>
    </Modal>
  );
}
