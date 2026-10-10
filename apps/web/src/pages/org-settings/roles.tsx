// SPDX-License-Identifier: Apache-2.0

import { useForm } from "react-hook-form";
import { useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Eye, Grid3x3, Plus, Rows3, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { ViewAsOrgRole } from "@appstrate/core/permissions";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { cn } from "@appstrate/ui/cn";
import { ApiError } from "../../api/client";
import {
  dependentsLabel,
  lockedReads,
  withRequiredReads,
} from "../../lib/role-permission-dependencies";
import { useCanPreviewRole, usePermissions } from "../../hooks/use-permissions";
import { useModalParam } from "../../hooks/use-modal-param";
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
import { DataTable } from "../../components/data-table";
import { Modal } from "../../components/modal";
import { PageActionsMenu } from "../../components/page-actions-menu";
import { ScopeMultiSelect } from "../../components/scope-multi-select";
import { SettingsGroup } from "../../components/settings/setting-row";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { ViewAsDialog } from "../../components/view-as-dialog";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { Spinner } from "../../components/spinner";
import { useRoleColumns } from "./role-columns";
import { RoleMatrix } from "./role-matrix";
import { CollectionTabs } from "../../components/collection-tabs";
import { ViewToggle } from "../../components/view-toggle";
import { OrgRolesList, OrgRolesMatrix } from "./org-roles";
import {
  groupPermissionsByResource,
  permissionLabel,
  permissionResourceLabel,
} from "../../lib/permission-labels";
import { rolesPageDeeds } from "./rbac-deeds";
import { errorMessage } from "../../lib/mutation-error";
import { parseViewAsPreset, viewAsPresetParam } from "../../lib/view-as-preset";

type RoleView = "list" | "matrix";
type RoleTab = "org" | "space";

export function OrgSettingsRolesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const location = useLocation();
  const { can } = usePermissions();
  const { data: roles, isLoading, error } = useRoles();
  const deleteRole = useDeleteRole();
  const canPreview = useCanPreviewRole();
  // Both modals have an address: `?role=<key>` (or `new`) and `?view-as`.
  const roleParam = useModalParam("role");
  const viewAsParam = useModalParam("view-as");
  // Tab and view are places too: `?tab=space&view=matrix` opens exactly that,
  // and Back undoes a switch. Each defaults to its first option, which is
  // then left out of the URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: RoleTab = searchParams.get("tab") === "space" ? "space" : "org";
  const view: RoleView = searchParams.get("view") === "matrix" ? "matrix" : "list";
  const setParam = (name: "tab" | "view", value: string, fallback: string) =>
    setSearchParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (value === fallback) out.delete(name);
        else out.set(name, value);
        return out;
      },
      { state: location.state },
    );
  const [confirmDelete, setConfirmDelete] = useState<RoleObject | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Authoring bundles is OSS platform code (#1452): the permission is the whole
  // gate, with no deployment-level feature on top of it.
  const canWrite = can("roles:write");
  const canDelete = can("roles:delete");
  const deeds = rolesPageDeeds({ canWrite, canPreview });

  const presets = (roles ?? []).filter((r) => r.kind === "preset");
  const custom = (roles ?? []).filter((r) => r.kind === "custom");

  // A row previews its own role: the dialog opens pre-filled, at an address.
  const previewSpaceRole = deeds.includes("view-as")
    ? (role: RoleObject) => viewAsParam.open(viewAsPresetParam({ kind: "space", key: role.key }))
    : undefined;
  const previewOrgRole = deeds.includes("view-as")
    ? (role: ViewAsOrgRole) => viewAsParam.open(viewAsPresetParam({ kind: "org", role }))
    : undefined;
  const presetColumns = useRoleColumns({
    onPreview: previewSpaceRole,
    canDelete: () => false,
    isDeleting: false,
    onDelete: () => {},
  });
  const customColumns = useRoleColumns({
    onPreview: previewSpaceRole,
    canDelete: () => canDelete,
    isDeleting: deleteRole.isPending,
    onDelete: (role) => {
      setDeleteError(null);
      setConfirmDelete(role);
    },
  });

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
          setDeleteError(errorMessage(err));
        },
      },
    );
  };

  // The row opens the role: to edit it when it is yours to edit, to read it
  // otherwise. A preset's permissions used to hide behind a disclosure on its
  // card; they are one click away now, on the same gesture as every row.
  // Keeps the tab and view in the address, so closing the role lands back on them.
  const roleHref = (role: RoleObject) => {
    const params = new URLSearchParams(searchParams);
    params.set("role", role.key);
    return `?${params.toString()}`;
  };
  const requested = roleParam.value;
  const target =
    requested && requested !== "new" ? roles?.find((role) => role.key === requested) : undefined;
  const editable = !!target && target.kind === "custom" && canWrite;
  const tableState = {
    isLoading,
    isError: Boolean(error),
    error: <ErrorState error={error} compact />,
  };

  return (
    <>
      {deeds.length > 0 && (
        <SettingsPageActions>
          <PageActionsMenu>
            {deeds.includes("create") && (
              <DropdownMenuItem
                data-page-action="create"
                data-testid="create-role-button"
                onSelect={() => roleParam.open("new")}
              >
                <Plus />
                {t("roles.create")}
              </DropdownMenuItem>
            )}
            {deeds.includes("view-as") && (
              <DropdownMenuItem
                data-page-action="view-as"
                data-testid="view-as-button"
                onSelect={() => viewAsParam.open()}
              >
                <Eye />
                {t("viewAs.trigger")}
              </DropdownMenuItem>
            )}
          </PageActionsMenu>
        </SettingsPageActions>
      )}

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <CollectionTabs
          value={tab}
          label={t("roles.tabTitle")}
          onChange={(next) => setParam("tab", next, "org")}
          options={[
            { value: "org", label: t("roles.tabOrg") },
            { value: "space", label: t("roles.tabSpace") },
          ]}
        />
        <ViewToggle
          value={view}
          onChange={(next) => setParam("view", next, "list")}
          options={[
            { id: "list", icon: Rows3, label: t("roles.viewList") },
            { id: "matrix", icon: Grid3x3, label: t("roles.viewMatrix") },
          ]}
        />
      </div>
      {tab === "org" &&
        (view === "matrix" ? <OrgRolesMatrix /> : <OrgRolesList onPreview={previewOrgRole} />)}
      {tab === "space" && (
        <>
          {view === "matrix" ? (
            isLoading ? (
              <LoadingState />
            ) : error ? (
              <ErrorState error={error} />
            ) : (
              <RoleMatrix roles={roles ?? []} />
            )
          ) : (
            <>
              <SettingsGroup title={t("roles.presetsSection")}>
                <DataTable
                  label={t("roles.presetsSection")}
                  columns={presetColumns}
                  rows={presets}
                  rowKey={(role) => role.key}
                  rowHref={roleHref}
                  rowState={() => location.state}
                  rowLabel={(role) => spaceRoleLabel(role, t) ?? role.name}
                  {...tableState}
                />
              </SettingsGroup>

              <SettingsGroup title={t("roles.customSection")}>
                <DataTable
                  label={t("roles.customSection")}
                  columns={customColumns}
                  rows={custom}
                  rowKey={(role) => role.id ?? role.key}
                  rowHref={roleHref}
                  rowState={() => location.state}
                  rowLabel={(role) => role.name}
                  {...tableState}
                  empty={
                    <EmptyState
                      message={t("roles.empty")}
                      hint={t("roles.emptyHint")}
                      icon={ShieldCheck}
                      compact
                    />
                  }
                />
              </SettingsGroup>
            </>
          )}
        </>
      )}

      {requested === "new" && canWrite && (
        <RoleFormModal key="new" role={null} onClose={roleParam.close} />
      )}
      {target && editable && (
        <RoleFormModal key={target.key} role={target} onClose={roleParam.close} />
      )}
      {target && !editable && <RoleViewModal role={target} onClose={roleParam.close} />}

      {viewAsParam.value !== null && canPreview && (
        <ViewAsDialog preset={parseViewAsPreset(viewAsParam.value)} onClose={viewAsParam.close} />
      )}

      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={t("roles.deleteTitle")}
        confirmLabel={t("btn.delete", { ns: "common" })}
        description={
          deleteError ??
          (confirmDelete ? t("roles.deleteConfirm", { name: confirmDelete.name }) : "")
        }
        isPending={deleteRole.isPending}
        keepOpenOnRefusal
        onConfirm={() => confirmDelete && onDelete(confirmDelete)}
      />
    </>
  );
}

/** A role you may not edit, read in place: what it is for, and what it grants. */
function RoleViewModal({ role, onClose }: { role: RoleObject; onClose: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const description = spaceRoleDescription(role, t);

  return (
    <Modal
      open
      onClose={onClose}
      title={spaceRoleLabel(role, t) ?? role.name}
      className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-lg"
    >
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
        <div>
          <div className="mb-2 text-sm font-medium">
            {t("roles.permissionCount", { count: role.permissions.length })}
          </div>
          <dl className="divide-border divide-y rounded-lg border">
            {groupPermissionsByResource([...role.permissions].sort()).map(
              ([resource, permissions]) => (
                <div
                  key={resource}
                  className="grid gap-1 px-3 py-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"
                >
                  <dt className="text-sm font-medium">{permissionResourceLabel(resource, t)}</dt>
                  <dd>
                    <ul className="text-muted-foreground space-y-0.5 text-sm">
                      {permissions.map((permission) => (
                        <li key={permission} title={permission}>
                          {permissionLabel(permission, t)}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              ),
            )}
          </dl>
        </div>
      </div>
    </Modal>
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
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [formError, setFormError] = useState<string | null>(null);

  const isPending = createRole.isPending || updateRole.isPending;

  const submit = (data: { key: string; name: string; description: string }) => {
    setFormError(null);
    const permissions = [...selected];
    if (isLoading || vocabularyError) return;
    if (permissions.length === 0) {
      setFormError(t("roles.formIncomplete"));
      return;
    }
    const trimmedKey = data.key.trim();
    const onError = (err: unknown) => setFormError(errorMessage(err));
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

  // The same picker API keys use for their scopes: a role's permissions are
  // the same vocabulary, so they are chosen the same way.
  const entries = (vocabulary ?? []).flatMap((group) => group.permissions);
  const available = entries.map((entry) => entry.permission);
  const availableSet = new Set(available);
  const sessionOnly = new Set(
    entries.filter((entry) => !entry.api_key_grantable).map((entry) => entry.permission),
  );
  // A read a selected action depends on alone is held: ticking the action
  // ticks it, unticking it is undone, and its note names what needs it. The
  // server refuses a role missing one (issue #1513); the picker answers first.
  const locked = lockedReads(selected, entries);
  const requiredBy = (permission: string) => {
    const dependents = locked.get(permission);
    return dependents
      ? t("roles.requiredBy", { actions: dependentsLabel(permission, dependents) })
      : null;
  };
  // Named by the server against its own vocabulary, and listed as it sends
  // them. NOT intersected with the selection: `selected` is seeded from the
  // GRANTED half alone, so the two sets are disjoint by construction and the
  // filter this replaces emptied the panel every time. It dated from when the
  // client derived both halves from one selection, and it outlived the change
  // that split them — while a save kept dropping the unknown permissions
  // silently, which is the very thing the panel is here to announce.
  const unavailable = role?.unavailable_permissions ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      title={role ? t("roles.editTitle") : t("roles.createTitle")}
      className="sm:max-w-lg"
      actions={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
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
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="role-name">{t("roles.nameLabel")}</Label>
          <Input
            id="role-name"
            maxLength={100}
            disabled={isPending}
            autoFocus
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "role-name-error" : undefined}
            className={cn(errors.name && "border-destructive")}
            {...register("name", {
              required: t("common:validation.required"),
              setValueAs: (value: string) => value.trim(),
            })}
          />
          {errors.name && (
            <div id="role-name-error" role="alert" className="text-destructive text-sm">
              {errors.name.message}
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="role-key">{t("roles.keyLabel")}</Label>
          <Input
            id="role-key"
            maxLength={64}
            disabled={isPending}
            placeholder="support-lead"
            aria-invalid={!!errors.key}
            aria-describedby="role-key-hint role-key-error"
            className={cn(errors.key && "border-destructive")}
            {...register("key", {
              required: t("common:validation.required"),
              setValueAs: (value: string) => value.trim(),
            })}
          />
          <div id="role-key-hint" className="text-muted-foreground text-sm">
            {t("roles.keyHint")}
          </div>
          {errors.key && (
            <div id="role-key-error" role="alert" className="text-destructive text-sm">
              {errors.key.message}
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="role-description">{t("roles.descriptionLabel")}</Label>
          <Input
            id="role-description"
            maxLength={500}
            disabled={isPending}
            {...register("description")}
          />
        </div>
        <div className="space-y-2">
          <Label>{t("roles.permissionsLabel")}</Label>
          {isLoading ? (
            <LoadingState />
          ) : vocabularyError ? (
            <div role="alert" className="space-y-2">
              <ErrorState error={vocabularyError} compact />
              <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
                {t("common:btn.retry")}
              </Button>
            </div>
          ) : (
            <ScopeMultiSelect
              available={available}
              selected={[...selected]}
              // The picker only knows the catalog; a permission it no longer
              // lists stays selected until it is removed on purpose, below.
              onChange={(next) => {
                setSelected(
                  withRequiredReads(
                    new Set([...next, ...[...selected].filter((p) => !availableSet.has(p))]),
                    entries,
                  ),
                );
                setFormError(null);
              }}
              hint={requiredBy}
              // The exception, marked where it applies: most permissions an API
              // key holding this role can use, these only a signed-in person.
              tag={(permission) =>
                sessionOnly.has(permission)
                  ? { label: t("roles.sessionOnly"), title: t("roles.sessionOnlyHelp") }
                  : null
              }
              labels={{
                all: t("roles.allPermissions"),
                none: t("roles.permissionsPlaceholder"),
                count: (count) => t("roles.selectedPermissions", { count }),
                search: t("roles.searchPermissions"),
                empty: t("roles.noMatchingPermissions"),
              }}
            />
          )}
          <UnavailablePermissions permissions={unavailable} />
        </div>
        {formError && (
          <p role="alert" className="text-destructive text-sm">
            {formError}
          </p>
        )}
      </form>
    </Modal>
  );
}
