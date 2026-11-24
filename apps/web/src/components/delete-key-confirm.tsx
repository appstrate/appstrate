// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ConfirmModal } from "./confirm-modal";
import {
  useDeleteModelProviderCredential,
  type ModelProviderCredentialInfo,
} from "../hooks/use-model-provider-credentials";
import { keyDeletionPrompt } from "../lib/key-deletion";

/** « Supprimer » on a key of Settings › Models: an organization key goes only once no model uses it. */
export function DeleteKeyConfirm({
  credential,
  referenceCountVerified,
  onClose,
}: {
  credential: ModelProviderCredentialInfo;
  referenceCountVerified: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const deleteCredential = useDeleteModelProviderCredential({ errorHandledByCaller: true });
  const { description, blocked } = keyDeletionPrompt(
    credential,
    t,
    deleteCredential.error,
    referenceCountVerified,
  );

  return (
    <ConfirmModal
      open
      keepOpenOnRefusal
      onClose={onClose}
      title={t("credentials.deleteTitle")}
      confirmLabel={t("credentials.delete")}
      description={description}
      confirmDisabled={blocked}
      isPending={deleteCredential.isPending}
      onConfirm={() =>
        deleteCredential.mutate({ params: { path: { id: credential.id } } }, { onSuccess: onClose })
      }
    />
  );
}
