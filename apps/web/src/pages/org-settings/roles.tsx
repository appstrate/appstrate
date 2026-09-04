// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { ApiError } from "../../api/client";
import { usePermissions } from "../../hooks/use-permissions";
import { useAppConfig } from "../../hooks/use-app-config";
import {
  spaceRoleDescription,
  spaceRoleLabel,
  useCreateRole,
  useDeleteRole,
  useRoleVocabulary,
  useRoles,
  useUpdateRole,
  type RoleObject,
} from "../../hooks/use-roles";
import { ConfirmModal } from "../../components/confirm-modal";
import { Modal } from "../../components/modal";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { Spinner } from "../../components/spinner";

export function OrgSettingsRolesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const { features } = useAppConfig();
  const canReadRoles = can("roles:read");
  const { data: roles, isLoading, error } = useRoles(canReadRoles);
  const deleteRole = useDeleteRole();

  const [editing, setEditing] = useState<RoleObject | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<RoleObject | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (!canReadRoles) return null;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

  // Defining bundles is the gated half; the four presets ship with the
  // platform and stay usable without the feature.
  const customRolesEnabled = !!features.custom_roles;
  const canWrite = customRolesEnabled && can("roles:write");
  const canDelete = customRolesEnabled && can("roles:delete");

  const presets = (roles ?? []).filter((r) => r.kind === "preset");
  const custom = (roles ?? []).filter((r) => r.kind === "custom");

  const onDelete = (role: RoleObject) => {
    if (!role.id) return;
    setDeleteError(null);
    deleteRole.mutate(
      { params: { path: { id: role.id } } },
      {
        onSuccess: () => {
          setConfirmDelete(null);
          toast.success(t("roles.deleted", { name: role.name }));
        },
        onError: (err) => {
          // 409 `role_in_use` reports two holders — live memberships and
          // PENDING invitations that assign the role. Reporting only the first
          // makes the refusal look wrong when the blocker is an invitation.
          if (err instanceof ApiError && err.code === "role_in_use") {
            const members = Number(err.details?.member_count ?? 0);
            const invitations = Number(err.details?.pending_invitation_count ?? 0);
            setDeleteError(
              [
                members > 0 ? t("roles.inUse", { count: members }) : null,
                invitations > 0 ? t("roles.inUseInvitations", { count: invitations }) : null,
              ]
                .filter(Boolean)
                .join(" ") || t("roles.inUse", { count: 0 }),
            );
            return;
          }
          setDeleteError(getErrorMessage(err));
        },
      },
    );
  };

  return (
    <>
      {!customRolesEnabled && (
        <Alert className="mb-4">
          <AlertDescription>{t("roles.customUnavailable")}</AlertDescription>
        </Alert>
      )}

      <div className="text-muted-foreground mb-4 text-sm font-medium">
        {t("roles.presetsSection")}
      </div>
      <div className="mb-8 flex flex-col gap-3">
        {presets.map((role) => (
          <RoleCard key={role.key} role={role} />
        ))}
      </div>

      <div className="mb-4 flex items-center justify-between">
        <span className="text-muted-foreground text-sm font-medium">
          {t("roles.customSection")}
        </span>
        {canWrite && (
          <Button data-testid="create-role-button" onClick={() => setCreating(true)}>
            {t("roles.create")}
          </Button>
        )}
      </div>

      {custom.length === 0 ? (
        <EmptyState
          message={t("roles.empty")}
          hint={t("roles.emptyHint")}
          icon={ShieldCheck}
          compact
        />
      ) : (
        <div className="flex flex-col gap-3">
          {custom.map((role) => (
            <RoleCard
              key={role.id ?? role.key}
              role={role}
              onEdit={canWrite ? () => setEditing(role) : undefined}
              onDelete={
                canDelete
                  ? () => {
                      setDeleteError(null);
                      setConfirmDelete(role);
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {(creating || editing) && (
        <RoleFormModal
          role={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={
          deleteError ??
          (confirmDelete ? t("roles.deleteConfirm", { name: confirmDelete.name }) : "")
        }
        isPending={deleteRole.isPending}
        onConfirm={() => confirmDelete && onDelete(confirmDelete)}
      />
    </>
  );
}

function RoleCard({
  role,
  onEdit,
  onDelete,
}: {
  role: RoleObject;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [open, setOpen] = useState(false);

  return (
    <div className="border-border bg-card rounded-lg border p-5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[0.95rem] font-semibold">{spaceRoleLabel(role, t)}</h3>
          <span className="text-muted-foreground text-sm">
            {spaceRoleDescription(role, t) ?? role.key}
          </span>
        </div>
        {role.kind === "preset" && <Badge variant="running">{t("roles.presetBadge")}</Badge>}
        {onEdit && (
          <Button variant="outline" size="sm" onClick={onEdit}>
            {t("btn.edit")}
          </Button>
        )}
        {onDelete && (
          <Button variant="destructive" size="sm" onClick={onDelete}>
            {t("btn.delete")}
          </Button>
        )}
      </div>

      <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
        <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm">
          <ChevronDown
            size={14}
            className={open ? "rotate-180 transition-transform" : "transition-transform"}
          />
          {t("roles.permissionCount", { count: role.permissions.length })}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {role.permissions.map((permission) => (
              <li
                key={permission}
                className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs"
              >
                {permission}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function RoleFormModal({ role, onClose }: { role: RoleObject | null; onClose: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: vocabulary, isLoading } = useRoleVocabulary();
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();

  const [key, setKey] = useState(role?.key ?? "");
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [formError, setFormError] = useState<string | null>(null);

  const isPending = createRole.isPending || updateRole.isPending;

  const toggle = (permission: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });

  const submit = () => {
    setFormError(null);
    const permissions = [...selected];
    const trimmedKey = key.trim();
    if (!name.trim() || !trimmedKey || permissions.length === 0) {
      setFormError(t("roles.formIncomplete"));
      return;
    }
    // Same slug shape the API validates, refused here so the user sees which
    // rule they broke instead of a generic 400.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmedKey)) {
      setFormError(t("roles.keyInvalid"));
      return;
    }
    const onError = (err: unknown) => setFormError(getErrorMessage(err));
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      permissions,
    };
    if (role?.id) {
      updateRole.mutate(
        { params: { path: { id: role.id } }, body: { ...body, key: trimmedKey } },
        { onSuccess: onClose, onError },
      );
      return;
    }
    createRole.mutate({ body: { ...body, key: trimmedKey } }, { onSuccess: onClose, onError });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={role ? t("roles.editTitle") : t("roles.createTitle")}
      className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          <Button onClick={submit} disabled={isPending}>
            {isPending ? <Spinner /> : t("btn.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="role-name">{t("roles.nameLabel")}</Label>
          <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="role-key">{t("roles.keyLabel")}</Label>
          <Input
            id="role-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="support-lead"
          />
          <p className="text-muted-foreground text-xs">{t("roles.keyHint")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="role-description">{t("roles.descriptionLabel")}</Label>
          <Input
            id="role-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("roles.permissionsLabel")}</legend>
          {isLoading ? (
            <LoadingState />
          ) : (
            (vocabulary ?? []).map((group) => (
              <div key={group.resource} className="border-border rounded-lg border p-3">
                <p className="mb-2 font-mono text-xs font-semibold">{group.resource}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.permissions.map((entry) => (
                    <label
                      key={entry.permission}
                      className="flex items-start gap-2 text-sm"
                      htmlFor={`perm-${entry.permission}`}
                    >
                      <Checkbox
                        id={`perm-${entry.permission}`}
                        checked={selected.has(entry.permission)}
                        onCheckedChange={() => toggle(entry.permission)}
                        className="mt-0.5"
                      />
                      <span className="flex flex-col">
                        <span className="font-mono text-xs">{entry.action}</span>
                        {!entry.api_key_grantable && (
                          <span className="text-muted-foreground text-xs">
                            {t("roles.sessionOnly")}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))
          )}
        </fieldset>

        {formError && <p className="text-destructive text-sm">{formError}</p>}
      </div>
    </Modal>
  );
}
