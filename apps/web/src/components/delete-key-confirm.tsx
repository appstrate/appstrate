// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ConfirmModal } from "./confirm-modal";
import {
  useDeleteModelProviderCredential,
  type ModelProviderCredentialInfo,
} from "../hooks/use-model-provider-credentials";

/**
 * « Supprimer » on a connection of a model configuration. A refusal (the organization's last
 * connection of the default model's configuration, `model_org_connection_required`) closes the
 * dialog and is toasted.
 */
export function DeleteKeyConfirm({
  credential,
  onClose,
}: {
  credential: ModelProviderCredentialInfo;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const deleteCredential = useDeleteModelProviderCredential();

  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={t("credentials.deleteTitle")}
      confirmLabel={t("credentials.delete")}
      description={t(
        credential.owner_type === "user"
          ? "credentials.deleteMemberConfirm"
          : "credentials.deleteConfirm",
        { label: credential.label },
      )}
      isPending={deleteCredential.isPending}
      onConfirm={() =>
        deleteCredential.mutate({ params: { path: { id: credential.id } } }, { onSuccess: onClose })
      }
    />
  );
}
