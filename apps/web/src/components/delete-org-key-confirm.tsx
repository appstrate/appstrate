// SPDX-License-Identifier: Apache-2.0

/**
 * « Supprimer la clé » for an organization key, in one gesture. The confirmation says what it
 * costs (the models that lose their access, and the default model to replace when the key
 * served it); on confirmation the models' rows go first (the server refuses a key that models
 * still reference), then the key. A partial failure is said inline, with what was done.
 * Mounted only while open, so its state starts clean.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { Label } from "@appstrate/ui/components/label";
import { ConfirmModal } from "./confirm-modal";
import { useDeleteOrgKey, type KeyDeletionOutcome } from "../hooks/use-delete-org-key";
import type { ModelProviderCredentialInfo } from "../hooks/use-model-provider-credentials";
import type { OrgModelInfo } from "../hooks/use-models";
import { planKeyDeletion } from "../lib/key-deletion";

function Report({ outcome }: { outcome: KeyDeletionOutcome }) {
  const { t } = useTranslation("settings");
  if (outcome.status === "models-left") {
    const { removed, failed, refusal } = outcome;
    return (
      <div className="text-destructive space-y-1 text-sm">
        <p>
          {removed.length > 0
            ? t("credentials.deletePartial", { done: removed.join(", "), left: failed.join(", ") })
            : t("credentials.deleteModelsFailed", { left: failed.join(", ") })}
        </p>
        {refusal && <p>{refusal}</p>}
      </div>
    );
  }
  if (outcome.status === "key-left") {
    return (
      <div className="text-destructive space-y-1 text-sm">
        <p>{t("credentials.deleteKeyFailed")}</p>
        {outcome.refusal && <p>{outcome.refusal}</p>}
      </div>
    );
  }
  return null;
}

export function DeleteOrgKeyConfirm({
  credential,
  models,
  onClose,
}: {
  credential: ModelProviderCredentialInfo;
  /** Every model of the organization, as the list answers (it re-reads after each write). */
  models: readonly OrgModelInfo[];
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const plan = planKeyDeletion(models, credential.id);
  const { run, isPending } = useDeleteOrgKey();
  const [newDefaultId, setNewDefaultId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<KeyDeletionOutcome | null>(null);

  const needsDefault = plan.defaultModel !== null;
  const blocked = needsDefault && (plan.replacements.length === 0 || newDefaultId === null);

  const description =
    plan.accessible.length > 0
      ? t("credentials.deleteWithModels", {
          label: credential.label,
          count: plan.accessible.length,
          models: plan.accessible.map((m) => m.label).join(", "),
        })
      : t("credentials.deleteConfirm", { label: credential.label });

  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={t("credentials.deleteTitle")}
      confirmLabel={t("credentials.delete")}
      description={description}
      confirmDisabled={blocked}
      isPending={isPending}
      keepOpenOnRefusal
      onConfirm={() => {
        void run({ credentialId: credential.id, plan, newDefaultId }).then((result) => {
          if (result.status === "done") onClose();
          else setOutcome(result);
        });
      }}
    >
      {plan.defaultModel && (
        <div className="mt-4 space-y-2">
          {plan.replacements.length > 0 ? (
            <>
              <Label htmlFor="delete-key-new-default" className="text-sm">
                {t("credentials.deleteDefault", { name: plan.defaultModel.label })}
              </Label>
              <Select value={newDefaultId ?? ""} onValueChange={setNewDefaultId}>
                <SelectTrigger id="delete-key-new-default">
                  <SelectValue placeholder={t("credentials.deleteDefaultPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {plan.replacements.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : (
            <p className="text-destructive text-sm">
              {t("credentials.deleteDefaultNoneLeft", { name: plan.defaultModel.label })}
            </p>
          )}
        </div>
      )}
      {outcome && (
        <div className="mt-4">
          <Report outcome={outcome} />
        </div>
      )}
    </ConfirmModal>
  );
}
