// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ConfirmModal } from "./confirm-modal";
import {
  useDeleteModelProviderCredential,
  type ModelProviderCredentialInfo,
} from "../hooks/use-model-provider-credentials";
import type { OrgModelInfo } from "../hooks/use-models";
import { keyDeletionPrompt } from "../lib/key-deletion";

/** « Supprimer » on a key of Settings › Models: an organization key goes only once no model uses it. */
export function DeleteKeyConfirm({
  credential,
  models,
  onClose,
}: {
  credential: ModelProviderCredentialInfo;
  /** Every model of the organization. */
  models: readonly OrgModelInfo[];
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const deleteCredential = useDeleteModelProviderCredential();
  const { description, blocked } = keyDeletionPrompt(credential, models, t);

  return (
    <ConfirmModal
      open
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
