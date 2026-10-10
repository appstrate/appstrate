// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BrainCircuit, Plus } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { usePermissions } from "../../hooks/use-permissions";
import {
  useModels,
  useDeleteModel,
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
  deduplicateLabel,
} from "../../hooks/use-model-provider-credentials";
import { useConnectionTest } from "../../hooks/use-connection-test";
import { NavigateKeepingState } from "../../components/navigate-keeping-state";
import { useModalParam, useModalTarget } from "../../hooks/use-modal-param";
import { ModelFormModal } from "../../components/model-form-modal";
import { CredentialFormModal } from "../../components/credential-form-modal";
import { CredentialsSection } from "../../components/model-credentials-section";
import { ConfirmModal } from "../../components/confirm-modal";
import { ErrorState, EmptyState } from "../../components/page-states";
import { useModelColumns } from "./model-columns";
import { DataTable } from "../../components/data-table";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { PageActionsMenu } from "../../components/page-actions-menu";
import { credentialUpdateBody } from "../../lib/personal-model-credentials";

export function ModelsList({
  models,
  isLoading,
  error,
  onCreate,
  onEdit,
  onDelete,
  onSetDefault,
  settingDefaultId,
  canWrite,
  canDelete,
  credentialLabels,
}: {
  models: OrgModelInfo[] | undefined;
  isLoading: boolean;
  error: unknown;
  onCreate: () => void;
  onEdit: (m: OrgModelInfo) => void;
  onDelete: (m: OrgModelInfo) => void;
  onSetDefault: (m: OrgModelInfo) => void;
  settingDefaultId: string | null;
  // Passed down rather than read here: the page resolves the permissions once,
  // and a second `usePermissions()` inside would be a second thing to keep in
  // step with the route that already gates this screen.
  canWrite: boolean;
  canDelete: boolean;
  /** The organization credentials' labels by id, for those the caller may read. */
  credentialLabels: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestModel();
  const { testingIds, testResults, handleTest } = useConnectionTest(testMutation);
  // Provider icons are a nicety: a member reading the model list may not hold
  // the registry's permission, and then gets none.
  const { data: registry } = useProvidersRegistry();

  const columns = useModelColumns({
    registry,
    testingIds,
    testResults,
    settingDefaultId,
    onTest: handleTest,
    onEdit,
    onDelete,
    onSetDefault,
    canWrite,
    canDelete,
    credentialLabels,
  });

  return (
    <>
      {canWrite && (
        <SettingsPageActions>
          <PageActionsMenu>
            <DropdownMenuItem data-page-action="create-model" onSelect={onCreate}>
              <Plus />
              {t("models.add")}
            </DropdownMenuItem>
          </PageActionsMenu>
        </SettingsPageActions>
      )}

      <DataTable
        label={t("models.tabTitle")}
        columns={columns}
        rows={models ?? []}
        rowKey={(m) => m.id}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState error={error} compact />}
        // No action of its own: the button above is the same one, and it stays.
        empty={<EmptyState message={t("models.empty")} icon={BrainCircuit} compact />}
      />
    </>
  );
}

export function OrgSettingsModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();

  const canWriteModels = can("models:write");
  const canDeleteModels = can("models:delete");
  const canReadCredentials = can("model-provider-credentials:read");
  const canWriteCredentials = can("model-provider-credentials:write");

  const [subTab, setSubTab] = useState<"models-list" | "credentials">("models-list");
  const [confirmState, setConfirmState] = useState<{
    type: "deleteModel" | "deleteCredential";
    label: string;
    id: string;
    /** A member's own credential, not the organization's. */
    personal?: boolean;
  } | null>(null);

  const { data: models, isLoading: modelsLoading, error: modelsError } = useModels();
  const newModel = useModalParam("newModel");
  const editModelParam = useModalTarget("editModel", models);
  const editModel = editModelParam.target ?? null;
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
  const setDefaultModelMutation = useSetDefaultModel();
  const modelForm = useModelFormHandler({
    editModel,
    onSuccess: closeModelModal,
  });

  const { data: credentials, isLoading: pkLoading, error: pkError } = useModelProviderCredentials();
  const newPk = useModalParam("newCredential");
  const editPkParam = useModalTarget("editCredential", credentials);
  const editPk = editPkParam.target ?? null;
  const pkModalOpen = newPk.value !== null || editPk !== null;
  const closePkModal = editPk ? editPkParam.close : newPk.close;
  // The credentials tab has its own resource; `models:read` alone does not open it.
  const activeTab = canReadCredentials ? subTab : "models-list";
  const createPkMutation = useCreateModelProviderCredential();
  const updatePkMutation = useUpdateModelProviderCredential();
  const deletePkMutation = useDeleteModelProviderCredential();

  if (!can("models:read")) return <NavigateKeepingState to="/org-settings/general" />;

  return (
    <>
      <Tabs value={activeTab} onValueChange={(v) => setSubTab(v as "models-list" | "credentials")}>
        <TabsList className="mb-4">
          <TabsTrigger value="models-list" data-testid="models-list-tab">
            {t("models.tabTitle")}
          </TabsTrigger>
          {/* The credentials tab is its own resource: `models:read` alone does
              not open it, so the trigger is absent rather than disabled — a tab
              you can click into a 403 is worse than one that was never there. */}
          {canReadCredentials && (
            <TabsTrigger value="credentials" data-testid="models-credentials-tab">
              {t("credentials.title")}
            </TabsTrigger>
          )}
        </TabsList>
      </Tabs>

      {activeTab === "models-list" && (
        <ModelsList
          models={models}
          credentialLabels={new Map((credentials ?? []).map((k) => [k.id, k.label]))}
          isLoading={modelsLoading}
          error={modelsError}
          onCreate={() => newModel.open()}
          onEdit={(m) => editModelParam.open(m.id)}
          onDelete={(m) => setConfirmState({ type: "deleteModel", label: m.label, id: m.id })}
          settingDefaultId={
            setDefaultModelMutation.isPending
              ? (setDefaultModelMutation.variables?.body.modelId ?? null)
              : null
          }
          onSetDefault={(m) => setDefaultModelMutation.mutate({ body: { modelId: m.id } })}
          canWrite={canWriteModels}
          canDelete={canDeleteModels}
        />
      )}

      {activeTab === "credentials" && (
        <>
          {/* Single entry point: the unified modal handles both API-key and OAuth
              flows. Removing a module from `MODULES` hides its OAuth tile from the
              in-modal provider picker with zero UI footprint here. */}
          {canWriteCredentials && (
            <SettingsPageActions>
              <PageActionsMenu>
                <DropdownMenuItem
                  data-page-action="create-credential"
                  onSelect={() => newPk.open()}
                >
                  <Plus />
                  {t("credentials.add")}
                </DropdownMenuItem>
              </PageActionsMenu>
            </SettingsPageActions>
          )}
          <CredentialsSection
            credentials={credentials}
            isLoading={pkLoading}
            error={pkError}
            onEdit={(pk) => editPkParam.open(pk.id)}
            onDelete={(pk) =>
              setConfirmState({
                type: "deleteCredential",
                label: pk.label,
                id: pk.id,
                personal: pk.owner_type === "user",
              })
            }
            // A refusal is toasted by the mutation cache; the rejection keeps the typed label.
            onRename={async (pk, newLabel) => {
              await updatePkMutation.mutateAsync({
                params: { path: { id: pk.id } },
                body: { label: newLabel },
              });
            }}
            onConnectOAuth={(credential) => editPkParam.open(credential.id)}
            showOwner
          />
        </>
      )}

      <ModelFormModal
        open={modelModalOpen}
        onClose={closeModelModal}
        model={editModel}
        isPending={modelForm.isPending}
        onSubmit={modelForm.onSubmit}
      />

      <CredentialFormModal
        open={pkModalOpen}
        onClose={closePkModal}
        credential={editPk}
        isPending={createPkMutation.isPending || updatePkMutation.isPending}
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
                : confirmState.personal
                  ? t("credentials.deleteMemberConfirm", { label: confirmState.label })
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
