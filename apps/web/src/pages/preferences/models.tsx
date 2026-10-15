// SPDX-License-Identifier: Apache-2.0

/**
 * Preferences › My providers: the caller's own keys and subscriptions, in the table of the
 * organization's providers narrowed to them, with the kind of each. The Models column says what each lets them use.
 */

import { Alert } from "@appstrate/ui/components/alert";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useQueryClient } from "@tanstack/react-query";
import { AlertDescription } from "@appstrate/ui/components/alert";
import { AlertTriangle, Plus } from "lucide-react";
import { ConfirmModal } from "../../components/confirm-modal";
import { useUrlModalTarget } from "../../hooks/use-url-modal";
import { CredentialFormModal } from "../../components/credential-form-modal";
import { ProvidersTable } from "../../components/providers-table";
import type { MenuAction } from "../../lib/menu-action";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import {
  deduplicateLabel,
  useCreateModelProviderCredential,
  useDeleteModelProviderCredential,
  useModelProviderCredentials,
  useProvidersRegistry,
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
import { invalidatePaths } from "../../lib/query-keys";
import { providerRows } from "../../lib/model-providers";
import { authStore } from "../../stores/auth-store";
import { EmptyStateAction } from "../../components/page-states";

export function PreferencesModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const userId = useStore(authStore, (s) => s.user?.id);
  const queryClient = useQueryClient();

  const canConnect = can("model-provider-credentials:connect");
  const { data: orgSettings } = useOrgSettings();
  // Until the settings load the flag is unknown: adding stays off, and nothing is withdrawn
  // from the credentials already held (deleting is never gated by the policy).
  const personalModelCredentialsDisabled = orgSettings?.personal_model_credentials === false;
  const personalModelCredentialsAllowed = orgSettings?.personal_model_credentials === true;
  const canAdd = canConnect && personalModelCredentialsAllowed;
  const credentialsQuery = useModelProviderCredentials();
  const modelsQuery = useModels();
  const { data: registry } = useProvidersRegistry();
  const createCredential = useCreateModelProviderCredential();
  const updateCredential = useUpdateModelProviderCredential();
  const deleteCredential = useDeleteModelProviderCredential();

  const [creating, setCreating] = useState(false);
  const credentials = ownPersonalCredentials(credentialsQuery.data ?? [], userId);
  const editParam = useUrlModalTarget("editCredential", credentialsQuery.data && credentials);
  const editCredential = editParam.target ?? null;
  const formOpen = (creating && canAdd) || editCredential !== null;
  const [confirmDelete, setConfirmDelete] = useState<ModelProviderCredentialInfo | null>(null);

  const rows = providerRows(modelsQuery.data ?? [], credentials, registry ?? [], userId).filter(
    (row) => row.credential !== null,
  );

  // A credential's add, rename, delete or pairing changes which models the caller can use.
  const refreshModels = () => {
    void invalidatePaths(queryClient, ["/api/models"]);
  };

  const closeForm = () => {
    (editCredential ? editParam.close : () => setCreating(false))();
    refreshModels();
  };

  const openCreate = () => setCreating(true);

  const openEdit = (credential: ModelProviderCredentialInfo) => editParam.open(credential.id);

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

  const addCredential: MenuAction = {
    id: "create-credential",
    icon: Plus,
    label: t("credentials.addPersonal"),
    onSelect: openCreate,
    hidden: !canAdd,
  };

  return (
    <>
      {personalModelCredentialsDisabled && (
        <Alert variant="warning" className="mb-4">
          <AlertTriangle size={16} />
          <AlertDescription>{t("modelCredentials.policyDisabled")}</AlertDescription>
        </Alert>
      )}

      <SettingsPageActions actions={[addCredential]} />

      <p className="text-muted-foreground mb-4 text-sm">{t("modelCredentials.description")}</p>

      <ProvidersTable
        label={t("preferences.tabModels")}
        rows={rows}
        showType
        isLoading={credentialsQuery.isLoading || modelsQuery.isLoading}
        error={credentialsQuery.error ?? modelsQuery.error}
        // The add deed is in the Actions menu, which is closed: the empty list repeats it.
        empty={{
          message: t("modelCredentials.empty"),
          hint: t("modelCredentials.emptyHint"),
          action: <EmptyStateAction action={addCredential} />,
        }}
        canWriteModels={false}
        onRename={renameCredential}
        onChangeKey={openEdit}
        onReconnect={openEdit}
        onDelete={setConfirmDelete}
      />

      {formOpen && (
        <CredentialFormModal
          key={editCredential?.id ?? "__create__"}
          onClose={closeForm}
          credential={editCredential}
          isPending={createCredential.isPending || updateCredential.isPending}
          onSubmit={submitForm}
          personal
        />
      )}

      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={t("credentials.deleteTitle")}
        confirmLabel={t("btn.delete", { ns: "common" })}
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
