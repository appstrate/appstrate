// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmModal } from "../../components/confirm-modal";
import { CredentialFormModal } from "../../components/credential-form-modal";
import { CredentialsSection } from "../../components/model-credentials-section";
import { ErrorState } from "../../components/page-states";
import { SettingsGroup } from "../../components/settings/setting-row";
import { Spinner } from "../../components/spinner";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { AlertTriangle, Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  deduplicateLabel,
  useCreateModelProviderCredential,
  useDeleteModelProviderCredential,
  useModelProviderCredentials,
  useUpdateModelProviderCredential,
  type ModelProviderCredentialInfo,
} from "../../hooks/use-model-provider-credentials";
import { useModels } from "../../hooks/use-models";
import { useOrgSettings } from "../../hooks/use-org-settings";
import { usePermissions } from "../../hooks/use-permissions";
import {
  credentialUpdateBody,
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
  const { data: orgSettings } = useOrgSettings();
  // Absent means allowed (the setting is opt-out). Only an explicit `false` withdraws adding:
  // a key or a subscription pairing is then refused, and existing credentials can still be deleted.
  const personalModelCredentialsDisabled = orgSettings?.personal_model_credentials === false;
  const credentialsQuery = useModelProviderCredentials();
  const modelsQuery = useModels();
  const createCredential = useCreateModelProviderCredential();
  const updateCredential = useUpdateModelProviderCredential();
  const deleteCredential = useDeleteModelProviderCredential();

  const [formOpen, setFormOpen] = useState(false);
  const [editCredential, setEditCredential] = useState<ModelProviderCredentialInfo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ModelProviderCredentialInfo | null>(null);

  const credentials = ownPersonalCredentials(credentialsQuery.data ?? [], userId);
  const paidByCaller = (modelsQuery.data ?? []).filter((m) => m.billed_to === "user");

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

  // A refusal is toasted by the mutation cache; the rejection keeps the typed label.
  const renameCredential = async (credential: ModelProviderCredentialInfo, label: string) => {
    await updateCredential.mutateAsync({
      params: { path: { id: credential.id } },
      body: { label },
    });
  };

  const submitForm = (data: { label: string; providerId: string; apiKey?: string }) => {
    if (editCredential) {
      // The provider is pinned at create time: only the label and the key change.
      updateCredential.mutate(
        {
          params: { path: { id: editCredential.id } },
          body: credentialUpdateBody(editCredential, data),
        },
        { onSuccess: closeForm },
      );
      return;
    }
    createCredential.mutate(
      {
        body: personalApiKeyBody({
          providerId: data.providerId,
          label: deduplicateLabel(data.label, credentials),
          apiKey: data.apiKey ?? "",
        }),
      },
      { onSuccess: closeForm },
    );
  };

  return (
    <>
      {personalModelCredentialsDisabled && (
        <Alert variant="warning" className="mb-4">
          <AlertTriangle size={16} />
          <AlertDescription>{t("modelCredentials.policyDisabled")}</AlertDescription>
        </Alert>
      )}

      <div className="mb-4 flex items-start justify-between gap-4">
        <p className="text-muted-foreground text-sm">{t("modelCredentials.description")}</p>
        {canConnect && !personalModelCredentialsDisabled && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={openCreate}
          >
            <Plus />
            {t("credentials.add")}
          </Button>
        )}
      </div>

      <CredentialsSection
        credentials={credentials}
        isLoading={credentialsQuery.isLoading}
        error={credentialsQuery.error}
        onEdit={openEdit}
        onDelete={(credential) => setConfirmDelete(credential)}
        onRename={renameCredential}
        onConnectOAuth={openEdit}
        canWrite={canConnect && !personalModelCredentialsDisabled}
        canDelete={canConnect}
        userId={userId}
        showOwner={false}
        empty={{
          message: t("modelCredentials.empty"),
          hint: t("modelCredentials.emptyHint"),
        }}
      />

      <SettingsGroup title={t("modelCredentials.billedTitle")}>
        {modelsQuery.isLoading ? (
          <Spinner />
        ) : modelsQuery.error ? (
          <ErrorState error={modelsQuery.error} compact />
        ) : paidByCaller.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
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
          <p className="text-muted-foreground text-sm">{t("modelCredentials.billedNone")}</p>
        )}
      </SettingsGroup>

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
