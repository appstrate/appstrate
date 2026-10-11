// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { BrainCircuit, ChevronRight, KeyRound, Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { usePermissions } from "../../hooks/use-permissions";
import {
  useModels,
  useDeleteModel,
  usePatchModel,
  useSetDefaultModel,
  useTestModel,
  useModelFormHandler,
  type OrgModelInfo,
} from "../../hooks/use-models";
import {
  useModelProviderCredentials,
  useCreateModelProviderCredential,
  useUpdateModelProviderCredential,
  useDeleteModelProviderCredential,
  useProvidersRegistry,
  useTestModelProviderCredential,
  deduplicateLabel,
  type ModelProviderCredentialInfo,
} from "../../hooks/use-model-provider-credentials";
import { useConnectionTest } from "../../hooks/use-connection-test";
import { NoAccessState } from "../../components/route-gate";
import { useModalParam, useModalTarget } from "../../hooks/use-modal-param";
import { ModelFormModal } from "../../components/model-form-modal";
import { CredentialFormModal } from "../../components/credential-form-modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { PreferencesModelsLink } from "../../components/preferences-models-link";
import { ErrorState, EmptyState, EmptyStateAction } from "../../components/page-states";
import { useMemberProviderColumns, useModelColumns, useModelGroupCell } from "./model-columns";
import { DataTable, type DataTableGroup } from "../../components/data-table";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { PageActionsMenu } from "../../components/page-actions-menu";
import { groupModels, isModelEditable, type ModelGroup } from "../../lib/model-groups";
import { credentialUpdateBody } from "../../lib/personal-model-credentials";
import { authStore } from "../../stores/auth-store";

/** The line under a provider with no model: the next step, in the table. */
function AddModelRow({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation("settings");
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      onClick={onAdd}
    >
      <Plus />
      {t("models.add")}
    </Button>
  );
}

interface ModelsTableProps {
  models: OrgModelInfo[] | undefined;
  /** The organization's providers, for a caller who may read them. */
  credentials: ModelProviderCredentialInfo[] | undefined;
  isLoading: boolean;
  error: unknown;
  onCreateModel: () => void;
  onCreateProvider: () => void;
  onAddModelTo: (pk: ModelProviderCredentialInfo) => void;
  onEditModel: (m: OrgModelInfo) => void;
  onEditProvider: (pk: ModelProviderCredentialInfo) => void;
  onDeleteModel: (m: OrgModelInfo) => void;
  onDeleteProvider: (pk: ModelProviderCredentialInfo) => void;
  onSetDefault: (m: OrgModelInfo) => void;
  onRenameModel: (m: OrgModelInfo, label: string) => Promise<void>;
  onRenameProvider: (pk: ModelProviderCredentialInfo, label: string) => Promise<void>;
  onToggleEnabled: (m: OrgModelInfo) => void;
  settingDefaultId: string | null;
  togglingId: string | null;
  // Passed down rather than read here: the page resolves the permissions once,
  // and a second `usePermissions()` inside would be a second thing to keep in
  // step with the route that already gates this screen.
  canWriteModels: boolean;
  canDeleteModels: boolean;
  canWriteProviders: boolean;
}

/** The organization's models, grouped under the provider that serves them. */
export function ModelsTable({
  models,
  credentials,
  isLoading,
  error,
  onCreateModel,
  onCreateProvider,
  onAddModelTo,
  onEditModel,
  onEditProvider,
  onDeleteModel,
  onDeleteProvider,
  onSetDefault,
  onRenameModel,
  onRenameProvider,
  onToggleEnabled,
  settingDefaultId,
  togglingId,
  canWriteModels,
  canDeleteModels,
  canWriteProviders,
}: ModelsTableProps) {
  const { t } = useTranslation(["settings", "common"]);
  const modelTest = useConnectionTest(useTestModel());
  const providerTest = useConnectionTest(useTestModelProviderCredential());
  const testingIds = new Set([...modelTest.testingIds, ...providerTest.testingIds]);
  const testResults = { ...modelTest.testResults, ...providerTest.testResults };
  // Provider icons are a nicety: a member reading the model list may not hold
  // the registry's permission, and then gets none.
  const { data: registry } = useProvidersRegistry();
  // One name is edited in place at a time: a model's or a provider's.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const columns = useModelColumns({
    registry,
    testingIds,
    testResults,
    settingDefaultId,
    togglingId,
    renamingId,
    onRenamingChange: setRenamingId,
    onTest: modelTest.handleTest,
    onEdit: onEditModel,
    onDelete: onDeleteModel,
    onSetDefault,
    onRename: onRenameModel,
    onToggleEnabled,
    canWrite: canWriteModels,
    canDelete: canDeleteModels,
  });
  const groupCell = useModelGroupCell({
    registry,
    testingIds,
    testResults,
    renamingId,
    onRenamingChange: setRenamingId,
    onTest: providerTest.handleTest,
    onEdit: onEditProvider,
    onDelete: onDeleteProvider,
    onRename: onRenameProvider,
    onAddModel: onAddModelTo,
    canWriteModels,
  });

  const groupLabel = (group: ModelGroup) =>
    group.kind === "personal"
      ? t("models.group.personal")
      : group.kind === "system"
        ? t("models.group.system")
        : (group.credential?.label ?? group.serviceName ?? t("models.col.provider"));

  const groups: DataTableGroup<OrgModelInfo>[] = groupModels(models ?? [], credentials ?? []).map(
    (group) => {
      const pk = group.kind === "provider" ? group.credential : null;
      return {
        key: group.key,
        label: groupLabel(group),
        cell: (columnId) => groupCell(group, columnId),
        rows: group.models,
        wide: group.kind !== "provider",
        // A provider with no model says what to do next, on its own line.
        emptyRow:
          pk && pk.bindable && canWriteModels ? (
            <AddModelRow onAdd={() => onAddModelTo(pk)} />
          ) : undefined,
        // A click on a key's row changes the key; the rows of the other groups just fold.
        onSelect:
          pk && pk.authMode !== "oauth2" && pk.allowed_actions.includes("edit")
            ? () => onEditProvider(pk)
            : undefined,
      };
    },
  );

  return (
    <DataTable
      label={t("models.tabTitle")}
      columns={columns}
      groups={groups}
      rowKey={(m) => m.id}
      rowAction={onEditModel}
      rowActionable={(m) => isModelEditable(m, canWriteModels)}
      rowLabel={(m) => m.label}
      isLoading={isLoading}
      isError={Boolean(error)}
      error={<ErrorState error={error} compact />}
      empty={
        <EmptyState message={t("models.empty")} icon={BrainCircuit} compact>
          <div className="flex flex-wrap justify-center gap-2">
            {canWriteProviders && (
              <EmptyStateAction label={t("credentials.add")} onClick={onCreateProvider} />
            )}
            {canWriteModels && <EmptyStateAction label={t("models.add")} onClick={onCreateModel} />}
          </div>
        </EmptyState>
      }
    />
  );
}

/** What every member brought, as a read-only table: only the holder changes a provider. */
export function MemberProvidersTable({
  credentials,
  isLoading,
  error,
}: {
  credentials: ModelProviderCredentialInfo[] | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  const { t } = useTranslation("settings");
  const userId = useStore(authStore, (s) => s.user?.id);
  const test = useConnectionTest(useTestModelProviderCredential());
  const { data: registry } = useProvidersRegistry();
  const columns = useMemberProviderColumns({
    registry,
    testingIds: test.testingIds,
    testResults: test.testResults,
    onTest: test.handleTest,
    userId,
  });

  return (
    <DataTable
      label={t("models.members.title")}
      columns={columns}
      rows={(credentials ?? []).filter((pk) => pk.owner_type === "user")}
      rowKey={(pk) => pk.id}
      isLoading={isLoading}
      isError={Boolean(error)}
      error={<ErrorState error={error} compact />}
      empty={<EmptyState message={t("models.members.empty")} icon={KeyRound} compact />}
    />
  );
}

/** The members' own providers, closed until asked: the organization reads them, it does not run them. */
function MemberProvidersSection(props: Parameters<typeof MemberProvidersTable>[0]) {
  const { t } = useTranslation("settings");
  return (
    <Collapsible className="mt-8">
      <CollapsibleTrigger className="group/members text-foreground flex cursor-pointer items-center gap-1.5 bg-transparent p-0 text-sm font-medium hover:bg-transparent">
        <ChevronRight className="size-4 transition-transform group-data-[state=open]/members:rotate-90" />
        {t("models.members.title")}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3">
        <p className="text-muted-foreground mb-3 text-sm">{t("models.members.description")}</p>
        <MemberProvidersTable {...props} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function OrgSettingsModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();

  const canWriteModels = can("models:write");
  const canDeleteModels = can("models:delete");
  const canReadCredentials = can("model-provider-credentials:read");
  const canWriteCredentials = can("model-provider-credentials:write");
  const canConnect = can("model-provider-credentials:connect");

  const [confirmState, setConfirmState] = useState<{
    type: "deleteModel" | "deleteCredential";
    label: string;
    id: string;
  } | null>(null);

  const { data: models, isLoading: modelsLoading, error: modelsError } = useModels();
  const { data: credentials, isLoading: pkLoading, error: pkError } = useModelProviderCredentials();
  const newModel = useModalParam("newModel");
  const editModelParam = useModalTarget("editModel", models);
  const editModel = editModelParam.target ?? null;
  // `?newModel=<provider id>` starts the new model bound to that provider.
  const presetProvider =
    (credentials ?? []).find((pk) => pk.id === newModel.value && pk.bindable) ?? null;
  const modelModalOpen = newModel.value !== null || editModel !== null;
  const closeModelModal = editModel ? editModelParam.close : newModel.close;

  // `org_models.credential_id` is ON DELETE RESTRICT (409 `credential_in_use`):
  // the dialog says so before asking the server.
  const modelsOnCredential =
    confirmState?.type === "deleteCredential"
      ? (models ?? []).filter((m) => m.credentialId === confirmState.id).length
      : 0;

  const closeConfirm = () => setConfirmState(null);
  const deleteModelMutation = useDeleteModel();
  const patchModelMutation = usePatchModel();
  const setDefaultModelMutation = useSetDefaultModel();
  const modelForm = useModelFormHandler({
    editModel,
    onSuccess: closeModelModal,
  });

  const newPk = useModalParam("newCredential");
  const editPkParam = useModalTarget("editCredential", credentials);
  const editPk = editPkParam.target ?? null;
  const pkModalOpen = newPk.value !== null || editPk !== null;
  const closePkModal = editPk ? editPkParam.close : newPk.close;
  const createPkMutation = useCreateModelProviderCredential();
  const updatePkMutation = useUpdateModelProviderCredential();
  const deletePkMutation = useDeleteModelProviderCredential();

  if (!can("models:read")) return <NoAccessState />;

  return (
    <>
      {(canWriteCredentials || canWriteModels) && (
        <SettingsPageActions>
          <PageActionsMenu>
            {/* Single entry point: the unified modal, API keys only (a subscription is personal). */}
            {canWriteCredentials && (
              <DropdownMenuItem data-page-action="create-credential" onSelect={() => newPk.open()}>
                <Plus />
                {t("credentials.add")}
              </DropdownMenuItem>
            )}
            {canWriteModels && (
              <DropdownMenuItem data-page-action="create-model" onSelect={() => newModel.open()}>
                <Plus />
                {t("models.add")}
              </DropdownMenuItem>
            )}
          </PageActionsMenu>
        </SettingsPageActions>
      )}

      <ModelsTable
        models={models}
        credentials={credentials}
        isLoading={modelsLoading || (canReadCredentials && pkLoading)}
        error={modelsError}
        onCreateModel={() => newModel.open()}
        onCreateProvider={() => newPk.open()}
        onAddModelTo={(pk) => newModel.open(pk.id)}
        onEditModel={(m) => editModelParam.open(m.id)}
        onEditProvider={(pk) => editPkParam.open(pk.id)}
        onDeleteModel={(m) => setConfirmState({ type: "deleteModel", label: m.label, id: m.id })}
        onDeleteProvider={(pk) =>
          setConfirmState({ type: "deleteCredential", label: pk.label, id: pk.id })
        }
        onSetDefault={(m) => setDefaultModelMutation.mutate({ body: { modelId: m.id } })}
        // A refusal is toasted by the mutation cache; the rejection keeps the label being typed.
        onRenameModel={async (m, label) => {
          await patchModelMutation.mutateAsync({ params: { path: { id: m.id } }, body: { label } });
        }}
        onRenameProvider={async (pk, label) => {
          await updatePkMutation.mutateAsync({ params: { path: { id: pk.id } }, body: { label } });
        }}
        onToggleEnabled={(m) =>
          patchModelMutation.mutate({
            params: { path: { id: m.id } },
            body: { enabled: !m.enabled },
          })
        }
        settingDefaultId={
          setDefaultModelMutation.isPending
            ? (setDefaultModelMutation.variables?.body.modelId ?? null)
            : null
        }
        togglingId={
          patchModelMutation.isPending && patchModelMutation.variables?.body.enabled !== undefined
            ? patchModelMutation.variables.params.path.id
            : null
        }
        canWriteModels={canWriteModels}
        canDeleteModels={canDeleteModels}
        canWriteProviders={canWriteCredentials}
      />

      {canConnect && (
        <p className="text-muted-foreground mt-3 text-sm">
          {t("models.personalFooter")}{" "}
          <PreferencesModelsLink>{t("models.personalFooterLink")}</PreferencesModelsLink>
        </p>
      )}

      {/* The members' own providers are the organization's to read, not to change: the
          section is there for the permission that reads them, and closed until asked. */}
      {canReadCredentials && (
        <MemberProvidersSection credentials={credentials} isLoading={pkLoading} error={pkError} />
      )}

      <ModelFormModal
        open={modelModalOpen}
        onClose={closeModelModal}
        model={editModel}
        credential={presetProvider}
        isPending={modelForm.isPending}
        onSubmit={modelForm.onSubmit}
      />

      <CredentialFormModal
        open={pkModalOpen}
        onClose={closePkModal}
        credential={editPk}
        isPending={createPkMutation.isPending || updatePkMutation.isPending}
        apiKeyOnly
        onSubmit={(data) => {
          if (editPk) {
            // The PATCH body only accepts mutable fields — the protocol and
            // endpoint are pinned by `providerId` at create time.
            updatePkMutation.mutate(
              {
                params: { path: { id: editPk.id } },
                body: credentialUpdateBody(editPk, data),
              },
              {
                onSuccess: closePkModal,
              },
            );
          } else {
            const uniqueLabel = deduplicateLabel(data.label, credentials ?? []);
            createPkMutation.mutate(
              {
                body: {
                  label: uniqueLabel,
                  providerId: data.providerId,
                  api_key: data.apiKey ?? "",
                  ...(data.baseUrlOverride ? { base_url_override: data.baseUrlOverride } : {}),
                },
              },
              {
                onSuccess: closePkModal,
              },
            );
          }
        }}
      />

      <ConfirmModal
        open={!!confirmState}
        onClose={closeConfirm}
        title={t(
          confirmState?.type === "deleteCredential"
            ? "credentials.deleteTitle"
            : "models.deleteTitle",
        )}
        confirmLabel={t("btn.delete", { ns: "common" })}
        description={
          confirmState?.type === "deleteModel"
            ? t("models.deleteConfirm", { label: confirmState.label })
            : confirmState?.type === "deleteCredential"
              ? modelsOnCredential > 0
                ? t("credentials.deleteInUse", {
                    label: confirmState.label,
                    count: modelsOnCredential,
                  })
                : t("credentials.deleteConfirm", { label: confirmState.label })
              : ""
        }
        confirmDisabled={modelsOnCredential > 0}
        isPending={deleteModelMutation.isPending || deletePkMutation.isPending}
        onConfirm={() => {
          if (!confirmState) return;
          const params = { path: { id: confirmState.id } };
          if (confirmState.type === "deleteModel") {
            deleteModelMutation.mutate({ params }, { onSuccess: closeConfirm });
          } else {
            deletePkMutation.mutate({ params }, { onSuccess: closeConfirm });
          }
        }}
      />
    </>
  );
}
