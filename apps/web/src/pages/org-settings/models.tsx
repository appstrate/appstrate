// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { BrainCircuit, KeyRound, Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
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
import { useConnectionTest } from "../../hooks/use-connection-test";
import { ModelFormModal } from "../../components/model-form-modal";
import { CredentialFormModal } from "../../components/credential-form-modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { ErrorState, EmptyState } from "../../components/page-states";
import { useCredentialColumns, useModelColumns } from "./model-columns";
import { DataTable } from "../../components/data-table";
import { TOOLBAR_ACTION } from "../../lib/toolbar-button";

function ModelsList({
  models,
  isLoading,
  error,
  onCreate,
  onEdit,
  onDelete,
  onSetDefault,
  settingDefaultId,
}: {
  models: OrgModelInfo[] | undefined;
  isLoading: boolean;
  error: unknown;
  onCreate: () => void;
  onEdit: (m: OrgModelInfo) => void;
  onDelete: (m: OrgModelInfo) => void;
  onSetDefault: (m: OrgModelInfo) => void;
  settingDefaultId: string | null;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestModel();
  const { testingIds, testResults, handleTest } = useConnectionTest(testMutation);
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
  });

  return (
    <>
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" className={TOOLBAR_ACTION} onClick={onCreate}>
          <Plus />
          {t("models.add")}
        </Button>
      </div>

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
}: {
  credentials: ModelProviderCredentialInfo[] | undefined;
  isLoading: boolean;
  error: unknown;
  onCreate: () => void;
  onEdit: (pk: ModelProviderCredentialInfo) => void;
  onDelete: (pk: ModelProviderCredentialInfo) => void;
  onRename: (pk: ModelProviderCredentialInfo, newLabel: string) => Promise<void>;
  onConnectOAuth: (credential: ModelProviderCredentialInfo) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestModelProviderCredential();
  const { testingIds, testResults, handleTest } = useConnectionTest(testMutation);
  const { data: registry } = useProvidersRegistry();

  const columns = useCredentialColumns({
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
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" className={TOOLBAR_ACTION} onClick={onCreate}>
          <Plus />
          {t("credentials.add")}
        </Button>
      </div>

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
  const { isAdmin } = usePermissions();

  const [subTab, setSubTab] = useState<"models-list" | "credentials">("models-list");
  const [confirmState, setConfirmState] = useState<{
    type: "deleteModel" | "deleteCredential";
    label: string;
    id: string;
  } | null>(null);

  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [editModel, setEditModel] = useState<OrgModelInfo | null>(null);
  const { data: models, isLoading: modelsLoading, error: modelsError } = useModels();
  const deleteModelMutation = useDeleteModel();
  const setDefaultModelMutation = useSetDefaultModel();
  const modelForm = useModelFormHandler({
    editModel,
    onSuccess: () => setModelModalOpen(false),
  });

  const [pkModalOpen, setPkModalOpen] = useState(false);
  const [editPk, setEditPk] = useState<ModelProviderCredentialInfo | null>(null);
  const { data: credentials, isLoading: pkLoading, error: pkError } = useModelProviderCredentials();
  const createPkMutation = useCreateModelProviderCredential();
  const updatePkMutation = useUpdateModelProviderCredential();
  const deletePkMutation = useDeleteModelProviderCredential();

  if (!isAdmin) return <Navigate to="/org-settings/general" replace />;

  return (
    <>
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as "models-list" | "credentials")}>
        <TabsList className="mb-4">
          <TabsTrigger value="models-list">{t("models.tabTitle")}</TabsTrigger>
          <TabsTrigger value="credentials">{t("credentials.title")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {subTab === "models-list" && (
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
        />
      )}

      {subTab === "credentials" && (
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
        onClose={() => setConfirmState(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={
          confirmState?.type === "deleteModel"
            ? t("models.deleteConfirm", { label: confirmState.label })
            : confirmState?.type === "deleteCredential"
              ? t("credentials.deleteConfirm", { label: confirmState.label })
              : ""
        }
        isPending={deleteModelMutation.isPending || deletePkMutation.isPending}
        onConfirm={() => {
          if (!confirmState) return;
          const close = () => setConfirmState(null);
          if (confirmState.type === "deleteModel") {
            deleteModelMutation.mutate(
              { params: { path: { id: confirmState.id } } },
              { onSuccess: close, onError: (error) => toast.error(getErrorMessage(error)) },
            );
          } else {
            deletePkMutation.mutate(
              { params: { path: { id: confirmState.id } } },
              { onSuccess: close, onError: (error) => toast.error(getErrorMessage(error)) },
            );
          }
        }}
      />
    </>
  );
}
