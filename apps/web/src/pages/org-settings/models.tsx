// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { BrainCircuit, KeyRound, Plus } from "lucide-react";
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
  useTestModelProviderCredential,
  useProvidersRegistry,
  deduplicateLabel,
  type ModelProviderCredentialInfo,
} from "../../hooks/use-model-provider-credentials";
import { getErrorMessage } from "@appstrate/core/errors";
import { ApiError } from "../../api/errors";
import { useConnectionTest } from "../../hooks/use-connection-test";
import { NavigateKeepingState } from "../../components/navigate-keeping-state";
import { ModelFormModal } from "../../components/model-form-modal";
import { CredentialFormModal } from "../../components/credential-form-modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { ErrorState, EmptyState } from "../../components/page-states";
import { useCredentialColumns, useModelColumns } from "./model-columns";
import { DataTable } from "../../components/data-table";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { PageActionsMenu } from "../../components/page-actions-menu";

function ModelsList({
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
  canReadCredentials,
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
  /** The provider registry sits behind `model-provider-credentials:read`. */
  canReadCredentials: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestModel();
  const { testingIds, testResults, handleTest } = useConnectionTest(testMutation);
  const { data: registry } = useProvidersRegistry(canReadCredentials);

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
        error={<ErrorState message={getErrorMessage(error)} compact />}
        // No action of its own: the button above is the same one, and it stays.
        empty={<EmptyState message={t("models.empty")} icon={BrainCircuit} compact />}
      />
    </>
  );
}

function CredentialsSection({
  credentials,
  isLoading,
  error,
  onCreate,
  onEdit,
  onDelete,
  onRename,
  onConnectOAuth,
  canWrite,
  canDelete,
}: {
  credentials: ModelProviderCredentialInfo[] | undefined;
  isLoading: boolean;
  error: unknown;
  onCreate: () => void;
  onEdit: (pk: ModelProviderCredentialInfo) => void;
  onDelete: (pk: ModelProviderCredentialInfo) => void;
  onRename: (pk: ModelProviderCredentialInfo, newLabel: string) => Promise<void>;
  onConnectOAuth: (credential: ModelProviderCredentialInfo) => void;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestModelProviderCredential();
  const { testingIds, testResults, handleTest } = useConnectionTest(testMutation);
  const { data: registry } = useProvidersRegistry();

  const columns = useCredentialColumns({
    canWrite,
    canDelete,
    registry,
    testingIds,
    testResults,
    onTest: handleTest,
    onEdit,
    onDelete,
    onRename,
    onConnectOAuth,
  });

  return (
    <div className="mb-8">
      {/* Single entry point — the unified modal handles both API-key and OAuth
          flows. Removing a module from `MODULES` hides its OAuth tile from the
          in-modal provider picker with zero UI footprint here. */}
      <SettingsPageActions>
        <PageActionsMenu>
          <DropdownMenuItem data-page-action="create-credential" onSelect={onCreate}>
            <Plus />
            {t("credentials.add")}
          </DropdownMenuItem>
        </PageActionsMenu>
      </SettingsPageActions>

      <DataTable
        label={t("credentials.title")}
        columns={columns}
        rows={credentials ?? []}
        rowKey={(pk) => pk.id}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={getErrorMessage(error)} compact />}
        empty={
          <EmptyState
            message={t("credentials.empty")}
            hint={t("credentials.emptyHint")}
            icon={KeyRound}
            compact
          />
        }
      />
    </div>
  );
}

export function OrgSettingsModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();

  const canWriteModels = can("models:write");
  const canDeleteModels = can("models:delete");
  const canReadCredentials = can("model-provider-credentials:read");
  const canWriteCredentials = can("model-provider-credentials:write");
  const canDeleteCredentials = can("model-provider-credentials:delete");

  const [subTab, setSubTab] = useState<"models-list" | "credentials">("models-list");
  const [confirmState, setConfirmState] = useState<{
    type: "deleteModel" | "deleteCredential";
    label: string;
    id: string;
  } | null>(null);

  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [editModel, setEditModel] = useState<OrgModelInfo | null>(null);
  const { data: models, isLoading: modelsLoading, error: modelsError } = useModels();

  // `org_models.credential_id` is ON DELETE RESTRICT (409 `credential_in_use`):
  // the dialog says so before asking the server.
  const modelsOnCredential =
    confirmState?.type === "deleteCredential"
      ? (models ?? []).filter((m) => m.credentialId === confirmState.id).length
      : 0;

  const closeConfirm = () => setConfirmState(null);
  const reportDeleteFailure = (err: unknown) => {
    toast.error(
      err instanceof ApiError && err.code === "credential_in_use"
        ? t("credentials.deleteRefused")
        : t("error.prefix", { ns: "common", message: getErrorMessage(err) }),
    );
    closeConfirm();
  };
  const deleteModelMutation = useDeleteModel();
  const setDefaultModelMutation = useSetDefaultModel();
  const modelForm = useModelFormHandler({
    editModel,
    onSuccess: () => setModelModalOpen(false),
  });

  const [pkModalOpen, setPkModalOpen] = useState(false);
  const [editPk, setEditPk] = useState<ModelProviderCredentialInfo | null>(null);
  const {
    data: credentials,
    isLoading: pkLoading,
    error: pkError,
  } = useModelProviderCredentials(canReadCredentials);
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
          isLoading={modelsLoading}
          error={modelsError}
          onCreate={() => {
            setEditModel(null);
            setModelModalOpen(true);
          }}
          onEdit={(m) => {
            setEditModel(m);
            setModelModalOpen(true);
          }}
          onDelete={(m) => setConfirmState({ type: "deleteModel", label: m.label, id: m.id })}
          settingDefaultId={
            setDefaultModelMutation.isPending
              ? (setDefaultModelMutation.variables?.body.modelId ?? null)
              : null
          }
          onSetDefault={(m) => setDefaultModelMutation.mutate({ body: { modelId: m.id } })}
          canWrite={canWriteModels}
          canDelete={canDeleteModels}
          canReadCredentials={canReadCredentials}
        />
      )}

      {activeTab === "credentials" && (
        <CredentialsSection
          credentials={credentials}
          isLoading={pkLoading}
          error={pkError}
          onCreate={() => {
            setEditPk(null);
            setPkModalOpen(true);
          }}
          onEdit={(pk) => {
            setEditPk(pk);
            setPkModalOpen(true);
          }}
          onDelete={(pk) =>
            setConfirmState({ type: "deleteCredential", label: pk.label, id: pk.id })
          }
          onRename={async (pk, newLabel) => {
            try {
              await updatePkMutation.mutateAsync({
                params: { path: { id: pk.id } },
                body: { label: newLabel },
              });
            } catch (error) {
              toast.error(getErrorMessage(error));
              throw error;
            }
          }}
          onConnectOAuth={(credential) => {
            setEditPk(credential);
            setPkModalOpen(true);
          }}
          canWrite={canWriteCredentials}
          canDelete={canDeleteCredentials}
        />
      )}

      <ModelFormModal
        open={modelModalOpen}
        onClose={() => setModelModalOpen(false)}
        model={editModel}
        isPending={modelForm.isPending}
        onSubmit={modelForm.onSubmit}
      />

      <CredentialFormModal
        open={pkModalOpen}
        onClose={() => setPkModalOpen(false)}
        credential={editPk}
        isPending={createPkMutation.isPending || updatePkMutation.isPending}
        onSubmit={(data) => {
          if (editPk) {
            // The PUT body only accepts mutable fields — `api`/`baseUrl` are
            // pinned by `providerId` at create time. Strip them here even
            // though the form disables those inputs on edit.
            const patch: { label?: string; apiKey?: string } = { label: data.label };
            if (data.apiKey) patch.apiKey = data.apiKey;
            updatePkMutation.mutate(
              { params: { path: { id: editPk.id } }, body: patch },
              {
                onSuccess: () => setPkModalOpen(false),
                onError: (error) => toast.error(getErrorMessage(error)),
              },
            );
          } else {
            const uniqueLabel = deduplicateLabel(data.label, credentials ?? []);
            createPkMutation.mutate(
              {
                body: {
                  label: uniqueLabel,
                  providerId: data.providerId,
                  apiKey: data.apiKey ?? "",
                  ...(data.baseUrlOverride ? { baseUrlOverride: data.baseUrlOverride } : {}),
                },
              },
              {
                onSuccess: () => setPkModalOpen(false),
                onError: (error) => toast.error(getErrorMessage(error)),
              },
            );
          }
        }}
      />

      <ConfirmModal
        open={!!confirmState}
        onClose={closeConfirm}
        title={t("btn.confirm", { ns: "common" })}
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
          const options = { onSuccess: closeConfirm, onError: reportDeleteFailure };
          const params = { path: { id: confirmState.id } };
          if (confirmState.type === "deleteModel") {
            deleteModelMutation.mutate({ params }, options);
          } else {
            deletePkMutation.mutate({ params }, options);
          }
        }}
      />
    </>
  );
}
