// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { ConfirmModal } from "../../components/confirm-modal";
import { CredentialFormModal } from "../../components/credential-form-modal";
import { CredentialsSection } from "../../components/model-credentials-section";
import { EmptyState, ErrorState, LoadingState } from "../../components/page-states";
import {
  deduplicateLabel,
  useCreateModelProviderCredential,
  useDeleteModelProviderCredential,
  useModelProviderCredentials,
  useUpdateModelProviderCredential,
  type ModelProviderCredentialInfo,
} from "../../hooks/use-model-provider-credentials";
import { useModels } from "../../hooks/use-models";
import { usePermissions } from "../../hooks/use-permissions";
import { errorMessage } from "../../lib/mutation-error";
import {
  modelsPaidByCaller,
  ownPersonalCredentials,
  personalApiKeyBody,
} from "../../lib/personal-model-credentials";
import { authStore } from "../../stores/auth-store";

export function PreferencesModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const userId = useStore(authStore, (s) => s.user?.id);
  const queryClient = useQueryClient();

  const canConnect = can("model-provider-credentials:connect");
  const credentialsQuery = useModelProviderCredentials();
  const modelsQuery = useModels();
  const createCredential = useCreateModelProviderCredential();
  const updateCredential = useUpdateModelProviderCredential();
  const deleteCredential = useDeleteModelProviderCredential();

  const [formOpen, setFormOpen] = useState(false);
  const [editCredential, setEditCredential] = useState<ModelProviderCredentialInfo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ModelProviderCredentialInfo | null>(null);

  if (credentialsQuery.isLoading) return <LoadingState />;
  if (credentialsQuery.error) return <ErrorState error={credentialsQuery.error} />;

  const allCredentials = credentialsQuery.data ?? [];
  const credentials = ownPersonalCredentials(allCredentials, userId);
  const paidByCaller = modelsPaidByCaller(modelsQuery.data ?? []);

  // A credential's add, rename, delete or pairing changes which models the caller pays for.
  const refreshModels = () => {
    void queryClient.invalidateQueries({ queryKey: ["get", "/api/models"] });
  };

  const closeForm = () => {
    setFormOpen(false);
    refreshModels();
  };

  const openCreate = () => {
    setEditCredential(null);
    setFormOpen(true);
  };

  const openEdit = (credential: ModelProviderCredentialInfo) => {
    setEditCredential(credential);
    setFormOpen(true);
  };

  const submitForm = (data: { label: string; providerId: string; apiKey?: string }) => {
    if (editCredential) {
      // The provider is pinned at create time: only the label and the key change.
      updateCredential.mutate(
        {
          params: { path: { id: editCredential.id } },
          body: {
            label: data.label,
            ...(data.apiKey && editCredential.authMode !== "oauth2"
              ? { api_key: data.apiKey }
              : {}),
          },
        },
        { onSuccess: closeForm },
      );
      return;
    }
    createCredential.mutate(
      {
        body: personalApiKeyBody({
          providerId: data.providerId,
          label: deduplicateLabel(data.label, allCredentials),
          apiKey: data.apiKey ?? "",
        }),
      },
      { onSuccess: closeForm },
    );
  };

  const addButton = canConnect ? (
    <Button onClick={openCreate}>{t("credentials.add")}</Button>
  ) : null;

  return (
    <>
      <p className="text-muted-foreground mb-4 text-sm">{t("modelCredentials.description")}</p>

      {credentials.length > 0 ? (
        <CredentialsSection
          credentials={credentials}
          isLoading={false}
          error={null}
          onCreate={openCreate}
          onEdit={openEdit}
          onDelete={(credential) => setConfirmDelete(credential)}
          onConnectOAuth={openEdit}
          canWrite={canConnect}
          canDelete={canConnect}
          userId={userId}
          showOwner={false}
        />
      ) : (
        <EmptyState
          message={t("modelCredentials.empty")}
          hint={t("modelCredentials.emptyHint")}
          icon={KeyRound}
          compact
        >
          {addButton}
        </EmptyState>
      )}

      <div className="border-border bg-card mt-6 rounded-lg border p-5">
        <h3 className="text-sm font-medium">{t("modelCredentials.billedTitle")}</h3>
        {modelsQuery.error ? (
          <p className="text-destructive mt-2 text-xs">{errorMessage(modelsQuery.error)}</p>
        ) : paidByCaller.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1.5">
            {paidByCaller.map((m) => (
              <li key={m.id} className="text-sm">
                {m.label}
                {m.provider_name && (
                  <span className="text-muted-foreground text-xs"> · {m.provider_name}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground mt-2 text-sm">{t("modelCredentials.billedNone")}</p>
        )}
      </div>

      <CredentialFormModal
        open={formOpen}
        onClose={closeForm}
        credential={editCredential}
        isPending={createCredential.isPending || updateCredential.isPending}
        onSubmit={submitForm}
        personal
      />

      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={
          confirmDelete ? t("modelCredentials.deleteConfirm", { label: confirmDelete.label }) : ""
        }
        isPending={deleteCredential.isPending}
        onConfirm={() => {
          if (!confirmDelete) return;
          deleteCredential.mutate(
            { params: { path: { id: confirmDelete.id } } },
            {
              onSuccess: () => {
                setConfirmDelete(null);
                refreshModels();
              },
            },
          );
        }}
      >
        <p className="text-muted-foreground text-sm">{t("modelCredentials.deleteImpact")}</p>
      </ConfirmModal>
    </>
  );
}
