// SPDX-License-Identifier: Apache-2.0

import { useForm } from "react-hook-form";
import { Field, FieldGroup } from "@appstrate/ui/components/field";
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
import { useCanPreviewRole, usePermissions } from "../../hooks/use-permissions";
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
import { ViewAsDialog } from "../../components/view-as-dialog";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { Spinner } from "../../components/spinner";

export function OrgSettingsRolesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const { features } = useAppConfig();
  const { data: roles, isLoading, error } = useRoles();
  const deleteRole = useDeleteRole();

  const [editing, setEditing] = useState<RoleObject | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const canPreview = useCanPreviewRole();
  const [confirmDelete, setConfirmDelete] = useState<RoleObject | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

      <div className="mb-4 flex items-center justify-between">
        <span className="text-muted-foreground text-sm font-medium">
          {t("roles.presetsSection")}
        </span>
        {canPreview && (
          <Button
            variant="outline"
            data-testid="view-as-button"
            onClick={() => setPreviewing(true)}
          >
            {t("viewAs.trigger")}
          </Button>
        )}
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

      {previewing && <ViewAsDialog onClose={() => setPreviewing(false)} />}

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
      <div className="flex flex-wrap items-center gap-3">
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

/** The unavailable half of the picker: what the row spells and this deployment cannot grant. */
export function UnavailablePermissions({ permissions }: { permissions: readonly string[] }) {
  const { t } = useTranslation(["settings", "common"]);
  if (permissions.length === 0) return null;
  return (
    <div className="border-destructive/40 rounded-lg border p-3">
      <p className="mb-1 font-mono text-xs font-semibold">{t("roles.unavailableGroup")}</p>
      <p className="text-muted-foreground mb-2 text-xs">{t("roles.unavailableHint")}</p>
      <ul className="flex flex-col gap-2">
        {permissions.map((permission) => (
          <li key={permission} className="font-mono text-xs">
            {permission}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RoleFormModal({ role, onClose }: { role: RoleObject | null; onClose: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: vocabulary, isLoading, error: vocabularyError, refetch } = useRoleVocabulary();
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    defaultValues: {
      key: role?.key ?? "",
      name: role?.name ?? "",
      description: role?.description ?? "",
    },
  });
  const [search, setSearch] = useState("");
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

  const submit = (data: { key: string; name: string; description: string }) => {
    setFormError(null);
    const permissions = [...selected];
    if (isLoading || vocabularyError) return;
    if (permissions.length === 0) {
      setFormError(t("roles.formIncomplete"));
      return;
    }
    const trimmedKey = data.key.trim();
    const onError = (err: unknown) => setFormError(getErrorMessage(err));
    const body = {
      name: data.name.trim(),
      description: data.description.trim() || null,
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

  const query = search.trim().toLowerCase();
  const groups = (vocabulary ?? [])
    .map((group) => ({
      ...group,
      permissions: group.permissions.filter((entry) =>
        entry.permission.toLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.permissions.length > 0);
  // Named by the server against its own vocabulary — the client re-deriving it
  // from the picker would be a second answer to the same question.
  const unavailable = (role?.unavailable_permissions ?? []).filter((permission) =>
    permission.toLowerCase().includes(query),
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={role ? t("roles.editTitle") : t("roles.createTitle")}
      className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          <Button
            type="submit"
            form="space-role-form"
            disabled={isPending || isLoading || !!vocabularyError}
          >
            {isPending ? <Spinner /> : t("btn.save")}
          </Button>
        </>
      }
    >
      <form
        id="space-role-form"
        noValidate
        onSubmit={handleSubmit(submit)}
        onChange={() => setFormError(null)}
        className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1"
      >
        <FieldGroup>
          <Field data-invalid={!!errors.name}>
            <Label htmlFor="role-name">{t("roles.nameLabel")}</Label>
            <Input
              id="role-name"
              maxLength={100}
              disabled={isPending}
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? "role-name-error" : undefined}
              {...register("name", {
                required: t("common:validation.required"),
                setValueAs: (value: string) => value.trim(),
              })}
            />
            {errors.name && (
              <p id="role-name-error" role="alert" className="text-destructive text-sm">
                {errors.name.message}
              </p>
            )}
          </Field>
          <Field data-invalid={!!errors.key}>
            <Label htmlFor="role-key">{t("roles.keyLabel")}</Label>
            <Input
              id="role-key"
              maxLength={64}
              disabled={isPending}
              placeholder="support-lead"
              aria-invalid={!!errors.key}
              aria-describedby="role-key-hint role-key-error"
              {...register("key", {
                required: t("common:validation.required"),
                setValueAs: (value: string) => value.trim(),
              })}
            />
            <p id="role-key-hint" className="text-muted-foreground text-xs">
              {t("roles.keyHint")}
            </p>
            {errors.key && (
              <p id="role-key-error" role="alert" className="text-destructive text-sm">
                {errors.key.message}
              </p>
            )}
          </Field>
          <Field>
            <Label htmlFor="role-description">{t("roles.descriptionLabel")}</Label>
            <Input
              id="role-description"
              maxLength={500}
              disabled={isPending}
              {...register("description")}
            />
          </Field>
        </FieldGroup>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("roles.permissionsLabel")}</legend>
          <div className="flex flex-col gap-2">
            <Label htmlFor="role-permission-search">{t("roles.searchPermissions")}</Label>
            <Input
              id="role-permission-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              disabled={isLoading || !!vocabularyError}
            />
            <p className="text-muted-foreground text-xs" aria-live="polite">
              {t("roles.selectedPermissions", { count: selected.size })}
            </p>
          </div>
          {isLoading ? (
            <LoadingState />
          ) : vocabularyError ? (
            <div role="alert">
              <ErrorState message={getErrorMessage(vocabularyError)} />
              <Button type="button" variant="outline" onClick={() => void refetch()}>
                {t("common:btn.retry")}
              </Button>
            </div>
          ) : (
            <>
              <UnavailablePermissions permissions={unavailable} />
              {groups.map((group) => (
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
                          disabled={isPending}
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
              ))}
            </>
          )}
        </fieldset>

        {!isLoading && !vocabularyError && groups.length === 0 && unavailable.length === 0 && (
          <p className="text-muted-foreground text-sm">{t("roles.noMatchingPermissions")}</p>
        )}
        {formError && (
          <p role="alert" className="text-destructive text-sm">
            {formError}
          </p>
        )}
      </form>
    </Modal>
  );
}
