// SPDX-License-Identifier: Apache-2.0

/**
 * « Choisir les modèles » of a configuration. The list is `ModelChoiceList`; this owns the footer,
 * the write (`useApplyModelChoice`) and the refusals it can name. A listing that asks the endpoint
 * (`discover`) goes through the configuration's organization key, or, with none, a key typed here
 * for the one request.
 *
 * The dialog opens once: its body alone changes (waiting, then the list). Swapping the `Modal`
 * itself would replay its backdrop and zoom.
 */

import { PendingButton } from "@/components/app-ui/pending-button";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { DialogFooter } from "@appstrate/ui/components/dialog";
import { FieldError } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import { FormItem } from "@/components/app-ui/form-item";
import { Modal } from "./modal";
import { ErrorState } from "./page-states";
import { TextSkeleton } from "./loading-skeletons";
import { ModelChoiceList } from "./model-choice";
import { useModelChoice, type DiscoverWith } from "../hooks/use-model-choice";
import { choiceRefusal, useApplyModelChoice } from "../hooks/use-apply-model-choice";
import {
  useModelProviderCredentials,
  useProvidersRegistry,
  type ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import { useModels, type OrgModelInfo } from "../hooks/use-models";
import { connectionsOfConfig, modelsOfConfig, type ModelConfigInfo } from "../lib/model-configs";
import { modelSource } from "../lib/model-source";
import { errorMessage } from "../lib/mutation-error";

interface ChoiceBodyProps {
  config: ModelConfigInfo;
  provider: ProviderRegistryEntry;
  existing: OrgModelInfo[];
  /** The configuration's usable organization API key, which a detection asks with. */
  orgKeyId: string | null;
  tickNew: boolean;
  onClose: () => void;
  onAdvanced?: (modelId: string) => void;
}

function ChoiceBody({
  config,
  provider,
  existing,
  orgKeyId,
  tickNew,
  onClose,
  onAdvanced,
}: ChoiceBodyProps) {
  const { t } = useTranslation(["settings", "common"]);
  const [inlineKey, setInlineKey] = useState("");
  const asksKey = modelSource(provider) === "discover" && orgKeyId === null;
  const discoverWith: DiscoverWith = orgKeyId
    ? { credentialId: orgKeyId }
    : inlineKey.trim()
      ? { inlineApiKey: inlineKey, configId: config.id }
      : null;
  const choice = useModelChoice({ provider, existing, discoverWith, tickNew });
  const { apply, isPending } = useApplyModelChoice();
  const [failed, setFailed] = useState<{ ids: string[]; refusal: string | null } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const save = async () => {
    setFailed(null);
    setRefusal(null);
    try {
      await apply({ plan: choice.plan, configId: config.id });
      onClose();
    } catch (err) {
      // Refused as a whole or entry by entry: either way nothing was written.
      const refused = choiceRefusal(err, choice.plan);
      if (refused) setFailed({ ids: refused.failedModelIds, refusal: refused.refusal });
      else setRefusal(errorMessage(err));
    }
  };

  const savedIds = new Map(existing.map((m) => [m.modelId, m.id]));

  return (
    <>
      <fieldset disabled={isPending} className="flex min-w-0 flex-col gap-3">
        <p className="text-muted-foreground text-sm">{t("modelConfigs.choice.intro")}</p>
        {asksKey && (
          <FormItem
            id="model-choice-key"
            label={t("credentials.form.apiKey")}
            hint={t("modelConfigs.choice.keyHint")}
          >
            <Input
              type="password"
              autoComplete="off"
              value={inlineKey}
              onChange={(e) => setInlineKey(e.target.value)}
              placeholder={t("credentials.form.apiKeyPlaceholder")}
            />
          </FormItem>
        )}
        <ModelChoiceList
          choice={choice}
          advanced={
            onAdvanced
              ? {
                  ids: new Set(existing.flatMap((m) => (m.modelId ? [m.modelId] : []))),
                  onOpen: (modelId) => {
                    const id = savedIds.get(modelId);
                    if (id) onAdvanced(id);
                  },
                }
              : undefined
          }
        />
        {refusal && <FieldError>{refusal}</FieldError>}
        {failed && (
          <FieldError>
            <span className="block">
              {t("models.choice.failed", { ids: failed.ids.join(", ") })}
            </span>
            {failed.refusal && <span className="mt-1 block">{failed.refusal}</span>}
          </FieldError>
        )}
      </fieldset>
      <ChoiceFooter
        onClose={onClose}
        onSubmit={() => void save()}
        pending={isPending}
        submitDisabled={!choice.canSave}
      />
    </>
  );
}

/** The footer, the same while the list waits (its submit off) and once it is there. */
function ChoiceFooter({
  onClose,
  onSubmit,
  pending = false,
  submitDisabled,
}: {
  onClose: () => void;
  onSubmit?: () => void;
  pending?: boolean;
  submitDisabled: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onClose}>
        {t("btn.cancel")}
      </Button>
      <PendingButton type="button" onClick={onSubmit} pending={pending} disabled={submitDisabled}>
        {t("btn.save")}
      </PendingButton>
    </DialogFooter>
  );
}

/**
 * The models of a configuration. Mounted only while open. `tickNew`: the configuration was just
 * made, its recommended models start ticked.
 */
export function ModelChoiceDialog({
  config,
  tickNew = false,
  onClose,
  onAdvanced,
}: {
  config: ModelConfigInfo;
  tickNew?: boolean;
  onClose: () => void;
  /** Where a saved model's finer settings open (the model form), by the model's id. */
  onAdvanced?: (modelId: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const registryQuery = useProvidersRegistry();
  const modelsQuery = useModels();
  const credentialsQuery = useModelProviderCredentials();
  const registry = registryQuery.data;
  const models = modelsQuery.data;
  const provider = registry?.find((p) => p.providerId === config.provider_id);
  const orgKey = connectionsOfConfig(credentialsQuery.data ?? [], config.id).org.find(
    (c) => c.authMode === "api_key" && !c.needs_reconnection,
  );

  return (
    // The configuration's label is known before the lists: the title does not change when they arrive.
    <Modal onClose={onClose} title={t("modelConfigs.choice.title", { label: config.label })}>
      {!registry || !models || !provider ? (
        <>
          {registryQuery.error || modelsQuery.error ? (
            <ErrorState error={registryQuery.error ?? modelsQuery.error} compact />
          ) : registry && models ? (
            <ErrorState message={t("models.form.providerUnavailable")} compact />
          ) : (
            <TextSkeleton lines={4} className="py-2" />
          )}
          <ChoiceFooter onClose={onClose} submitDisabled />
        </>
      ) : (
        <ChoiceBody
          config={config}
          provider={provider}
          existing={modelsOfConfig(models, config.id)}
          orgKeyId={orgKey?.id ?? null}
          tickNew={tickNew}
          onClose={onClose}
          onAdvanced={onAdvanced}
        />
      )}
    </Modal>
  );
}
