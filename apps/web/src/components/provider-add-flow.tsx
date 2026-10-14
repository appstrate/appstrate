// SPDX-License-Identifier: Apache-2.0

/**
 * « Ajouter une clé org », for the organization: a key, then the models it makes available. Nothing
 * is written until the second step's button: one click creates the provider and its models.
 * « Back » returns to the first step with what was typed. A subscription is paired instead: the
 * helper creates it, the flow closes, and its row chooses its models like any organization key.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CredentialFormModal, type CredentialFormData } from "./credential-form-modal";
import { NewProviderModelsModal } from "./model-choice-dialog";
import type { NewProviderCredential } from "../hooks/use-model-choice";
import {
  deduplicateLabel,
  type ModelProviderCredentialInfo,
} from "../hooks/use-model-provider-credentials";

export function ProviderAddFlow({
  credentials,
  onClose,
}: {
  /** The organization's providers, so that the new one gets a name of its own. */
  credentials: ModelProviderCredentialInfo[];
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const [typed, setTyped] = useState<CredentialFormData | undefined>();
  const [draft, setDraft] = useState<NewProviderCredential | null>(null);

  if (draft) {
    return <NewProviderModelsModal draft={draft} onBack={() => setDraft(null)} onClose={onClose} />;
  }
  return (
    <CredentialFormModal
      open
      onClose={onClose}
      credential={null}
      isPending={false}
      initial={typed}
      submitLabel={t("credentials.form.next")}
      onSubmit={(data) => {
        setTyped(data);
        setDraft({
          label: deduplicateLabel(data.label, credentials),
          providerId: data.providerId,
          apiKey: data.apiKey ?? "",
          ...(data.baseUrlOverride ? { baseUrlOverride: data.baseUrlOverride } : {}),
        });
      }}
    />
  );
}
