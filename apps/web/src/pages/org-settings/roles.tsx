// SPDX-License-Identifier: Apache-2.0

import { useForm } from "react-hook-form";
import { useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Eye, Grid3x3, Plus, Rows3, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Tabs, TabsContent } from "@appstrate/ui/components/tabs";
import { cn } from "@appstrate/ui/cn";
import { ApiError } from "../../api/client";
import { useCanPreviewRole, usePermissions } from "../../hooks/use-permissions";
import { useAppConfig } from "../../hooks/use-app-config";
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
import { unavailablePermissions } from "../../lib/role-permissions";
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
import { DetailTabsList, DetailTabsTrigger } from "../../components/agent-detail/agent-local-tabs";
import { ViewToggle } from "../../components/view-toggle";
import { OrgRolesList, OrgRolesMatrix } from "./org-roles";
import {
  groupPermissionsByResource,
  permissionLabel,
  permissionResourceLabel,
} from "../../lib/permission-labels";
import { rolesPageDeeds } from "./rbac-deeds";

type RoleView = "list" | "matrix";
type RoleTab = "org" | "space";

export function OrgSettingsRolesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const location = useLocation();
  const { can } = usePermissions();
  const { features } = useAppConfig();
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

  // Defining bundles is the gated half; the presets ship with the platform
  // and stay usable without the feature.
  const customRolesEnabled = !!features.custom_roles;
  const canWrite = customRolesEnabled && can("roles:write");
  const canDelete = customRolesEnabled && can("roles:delete");
  const deeds = rolesPageDeeds({ canWrite, canPreview });

  const presets = (roles ?? []).filter((r) => r.kind === "preset");
  const custom = (roles ?? []).filter((r) => r.kind === "custom");

  const presetColumns = useRoleColumns({
    canDelete: () => false,
    isDeleting: false,
    onDelete: () => {},
  });
  const customColumns = useRoleColumns({
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
          setDeleteError(getErrorMessage(err));
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
    error: <ErrorState message={getErrorMessage(error)} compact />,
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

      <Tabs value={tab} onValueChange={(next) => setParam("tab", next, "org")}>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <DetailTabsList aria-label={t("roles.tabTitle")}>
            <DetailTabsTrigger value="org">{t("roles.tabOrg")}</DetailTabsTrigger>
            <DetailTabsTrigger value="space">{t("roles.tabSpace")}</DetailTabsTrigger>
          </DetailTabsList>
          <ViewToggle
            value={view}
            onChange={(next) => setParam("view", next, "list")}
            options={[
              { id: "list", icon: Rows3, label: t("roles.viewList") },
              { id: "matrix", icon: Grid3x3, label: t("roles.viewMatrix") },
            ]}
          />
        </div>
        <TabsContent value="org" className="mt-0">
          {view === "matrix" ? <OrgRolesMatrix /> : <OrgRolesList />}
        </TabsContent>
        <TabsContent value="space" className="mt-0">
          {!customRolesEnabled && (
            <Alert className="mb-6">
              <AlertDescription>{t("roles.customUnavailable")}</AlertDescription>
            </Alert>
          )}
          {view === "matrix" ? (
            isLoading ? (
              <LoadingState />
            ) : error ? (
              <ErrorState message={getErrorMessage(error)} />
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
        </TabsContent>
      </Tabs>

      {requested === "new" && canWrite && (
        <RoleFormModal key="new" role={null} onClose={roleParam.close} />
      )}
      {target && editable && (
        <RoleFormModal key={target.key} role={target} onClose={roleParam.close} />
      )}
      {target && !editable && <RoleViewModal role={target} onClose={roleParam.close} />}

      {viewAsParam.value !== null && canPreview && <ViewAsDialog onClose={viewAsParam.close} />}

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

/** The unavailable half of the picker: named, explained, and removable. */
export function UnavailablePermissions({
  permissions,
  onRemove,
  disabled,
}: {
  permissions: readonly string[];
  onRemove: (permission: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  if (permissions.length === 0) return null;
  return (
    <div className="border-destructive/40 rounded-lg border p-3">
      <p className="mb-1 font-mono text-xs font-semibold">{t("roles.unavailableGroup")}</p>
      <p className="text-muted-foreground mb-2 text-xs">{t("roles.unavailableHint")}</p>
      <ul className="flex flex-col gap-2">
        {permissions.map((permission) => (
          <li key={permission} className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs">{permission}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              aria-label={t("roles.unavailableRemove", { permission })}
              onClick={() => onRemove(permission)}
            >
              {t("btn.remove", { ns: "common" })}
            </Button>
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

  // The same picker API keys use for their scopes: a role's permissions are
  // the same vocabulary, so they are chosen the same way.
  const available = (vocabulary ?? []).flatMap((group) =>
    group.permissions.map((entry) => entry.permission),
  );
  const availableSet = new Set(available);
  const sessionOnly = new Set(
    (vocabulary ?? []).flatMap((group) =>
      group.permissions
        .filter((entry) => !entry.api_key_grantable)
        .map((entry) => entry.permission),
    ),
  );
  // Only meaningful once the vocabulary answered: before that, everything is
  // unknown for the wrong reason.
  const unavailable = vocabulary ? unavailablePermissions(selected, vocabulary) : [];

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
              <ErrorState message={getErrorMessage(vocabularyError)} compact />
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
                  new Set([...next, ...[...selected].filter((p) => !availableSet.has(p))]),
                );
                setFormError(null);
              }}
              hint={(permission) => (sessionOnly.has(permission) ? t("roles.sessionOnly") : null)}
              labels={{
                all: t("roles.allPermissions"),
                none: t("roles.permissionsPlaceholder"),
                count: (count) => t("roles.selectedPermissions", { count }),
                search: t("roles.searchPermissions"),
                empty: t("roles.noMatchingPermissions"),
              }}
            />
          )}
          <UnavailablePermissions
            permissions={unavailable}
            onRemove={toggle}
            disabled={isPending}
          />
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
