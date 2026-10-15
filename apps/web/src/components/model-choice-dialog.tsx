// SPDX-License-Identifier: Apache-2.0

/**
 * The dialog around « Choose the models »: an organization key's, the personal keys' per
 * service, and the second step of « Ajouter une clé org ». The list is `ModelChoiceList`; this owns
 * the footer, the write (`useApplyModelChoice`) and the refusals it can name.
 */

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { FieldError, FormItem } from "@appstrate/ui/components/field";
import { OptionSelect } from "@appstrate/ui/components/select";
import { Modal } from "./modal";
import { ErrorState } from "./page-states";
import { TextSkeleton } from "./loading-skeletons";
import { ModelChoiceList } from "./model-choice";
import { useModelChoice, type DiscoverWith } from "../hooks/use-model-choice";
import {
  attemptTarget,
  useApplyModelChoice,
  type NewProviderCredential,
} from "../hooks/use-apply-model-choice";
import {
  useProvidersRegistry,
  type ModelProviderCredentialInfo,
  type ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import { useModels, type OrgModelInfo } from "../hooks/use-models";
import { errorMessage } from "../lib/mutation-error";
import { knownModels } from "@/lib/model-choice";
import { isSystemModel, memberModels } from "@/lib/model-providers";
import { resolveProviderEntry } from "@/lib/provider-registry-helpers";

interface ChoiceDialogProps {
  title: string;
  /** A sentence under the title, before the list. */
  intro?: ReactNode;
  provider: ProviderRegistryEntry;
  existing: OrgModelInfo[];
  /** Where the models live: an organization key, or none (each person's own). */
  credentialId: string | null;
  /** The organization key needs reconnecting: none of its models can become the default. */
  credentialUnavailable?: boolean;
  /** « Ajouter une clé org »: the key to mint with the models, and the way back to its form. */
  newCredential?: NewProviderCredential;
  onBack?: () => void;
  discoverWith: DiscoverWith;
  tickAll: boolean;
  hasDefault: boolean;
  submitLabel: string;
  onClose: () => void;
  /** Where a saved model's finer settings open (the model form), by the model's id. */
  onAdvanced?: (modelId: string) => void;
  /** Above the list: the service picker of the personal keys. */
  header?: ReactNode;
}

function ChoiceDialog({
  title,
  intro,
  provider,
  existing: given,
  credentialId,
  credentialUnavailable,
  newCredential,
  onBack,
  discoverWith,
  tickAll,
  hasDefault,
  submitLabel,
  onClose,
  onAdvanced,
  header,
}: ChoiceDialogProps) {
  const { t } = useTranslation(["settings", "common"]);
  // What a refused submission already created is known to the retry, which asks only for the rest.
  const [created, setCreated] = useState<OrgModelInfo[]>([]);
  const existing = knownModels(given, created);
  const choice = useModelChoice({
    provider,
    existing,
    discoverWith,
    tickAll,
    hasDefault,
  });
  const { apply, isPending } = useApplyModelChoice();
  // The key a refused submission already minted (`attemptTarget`).
  const [minted, setMinted] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ ids: string[]; refusal: string | null } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const save = async () => {
    setFailed(null);
    setRefusal(null);
    try {
      const outcome = await apply({
        plan: choice.plan,
        existing,
        ...attemptTarget(minted, { credentialId, providerId: provider.providerId, newCredential }),
      });
      if (outcome.credentialId) setMinted(outcome.credentialId);
      setCreated((models) => [...models, ...outcome.createdModels]);
      if (outcome.failedModelIds.length === 0) onClose();
      else setFailed({ ids: outcome.failedModelIds, refusal: outcome.refusal });
    } catch (err) {
      // The key was refused: nothing was written.
      setRefusal(errorMessage(err));
    }
  };

  const savedIds = new Map(existing.map((m) => [m.modelId, m.id]));

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      actions={
        <>
          {onBack && (
            <Button
              type="button"
              variant="outline"
              className="mr-auto"
              onClick={onBack}
              disabled={isPending}
            >
              {t("btn.back", { ns: "common" })}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            pending={isPending}
            disabled={!tickAll && !choice.canSave}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <fieldset disabled={isPending} className="min-w-0 space-y-3">
        {intro && <p className="text-muted-foreground text-sm">{intro}</p>}
        {header}
        <ModelChoiceList
          choice={choice}
          defaultUnavailable={credentialUnavailable}
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
    </Modal>
  );
}

/** The models an organization key serves. Mounted only while open. */
export function ProviderModelsModal({
  credential,
  onClose,
  onAdvanced,
}: {
  credential: ModelProviderCredentialInfo;
  onClose: () => void;
  onAdvanced: (modelId: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const registryQuery = useProvidersRegistry();
  const modelsQuery = useModels();
  const registry = registryQuery.data;
  const provider = registry ? resolveProviderEntry(credential, registry) : undefined;

  if (!registry || !modelsQuery.data) {
    return (
      <Modal open onClose={onClose} title={t("models.choice.title")}>
        {registryQuery.error || modelsQuery.error ? (
          <ErrorState error={registryQuery.error ?? modelsQuery.error} compact />
        ) : (
          <TextSkeleton lines={4} className="py-2" />
        )}
      </Modal>
    );
  }
  if (!provider) {
    return (
      <Modal open onClose={onClose} title={t("models.choice.title")}>
        <ErrorState message={t("models.form.providerUnavailable")} compact />
      </Modal>
    );
  }
  const models = modelsQuery.data;
  return (
    <ChoiceDialog
      title={t("models.choice.titleOf", { name: credential.label })}
      intro={t("models.choice.orgIntro", { service: provider.displayName })}
      provider={provider}
      existing={models.filter((m) => m.credentialId === credential.id && !isSystemModel(m))}
      credentialId={credential.id}
      credentialUnavailable={credential.needs_reconnection === true}
      discoverWith={{ credentialId: credential.id }}
      tickAll={false}
      hasDefault={models.some((m) => m.is_default)}
      submitLabel={t("btn.save")}
      onClose={onClose}
      onAdvanced={onAdvanced}
    />
  );
}

/** The models usable with a personal key, per service. Mounted only while open. */
export function PersonalModelsModal({
  services,
  providerId,
  onChangeService,
  onClose,
  onAdvanced,
}: {
  /** The services whose models may be left to each person's own key (`personalModelServices`). */
  services: ProviderRegistryEntry[];
  providerId: string;
  onChangeService: (providerId: string) => void;
  onClose: () => void;
  onAdvanced: (modelId: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const modelsQuery = useModels();
  const provider = services.find((s) => s.providerId === providerId) ?? services[0];
  const models = modelsQuery.data;

  if (!models || !provider) {
    return (
      <Modal open onClose={onClose} title={t("models.choice.personalTitle")}>
        {modelsQuery.error ? (
          <ErrorState error={modelsQuery.error} compact />
        ) : (
          <TextSkeleton lines={4} className="py-2" />
        )}
      </Modal>
    );
  }
  return (
    <ChoiceDialog
      // A service has its own list, ticks and detection: another service starts over.
      key={provider.providerId}
      title={t("models.choice.personalTitle")}
      intro={t("models.choice.personalIntro")}
      provider={provider}
      existing={memberModels(models).filter((m) => m.providerId === provider.providerId)}
      credentialId={null}
      discoverWith={null}
      tickAll={false}
      hasDefault={models.some((m) => m.is_default)}
      submitLabel={t("btn.save")}
      onClose={onClose}
      onAdvanced={onAdvanced}
      header={
        <FormItem id="personal-models-service" label={t("models.form.provider")}>
          <OptionSelect
            value={provider.providerId}
            onValueChange={onChangeService}
            options={services.map((service) => ({
              value: service.providerId,
              label: service.displayName,
            }))}
          />
        </FormItem>
      }
    />
  );
}

/** Step 2 of « Ajouter une clé org »: the models the new key makes available, all ticked. */
export function NewProviderModelsModal({
  draft,
  onBack,
  onClose,
}: {
  draft: NewProviderCredential;
  onBack: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const registryQuery = useProvidersRegistry();
  const modelsQuery = useModels();
  const provider = registryQuery.data?.find((p) => p.providerId === draft.providerId);

  if (!registryQuery.data || !modelsQuery.data || !provider) {
    return (
      <Modal open onClose={onClose} title={t("credentials.form.title")}>
        {registryQuery.error || modelsQuery.error ? (
          <ErrorState error={registryQuery.error ?? modelsQuery.error} compact />
        ) : registryQuery.data ? (
          <ErrorState message={t("models.form.providerUnavailable")} compact />
        ) : (
          <TextSkeleton lines={4} className="py-2" />
        )}
      </Modal>
    );
  }
  return (
    <ChoiceDialog
      title={t("credentials.form.title")}
      intro={t("models.choice.newIntro", { service: provider.displayName })}
      provider={provider}
      existing={[]}
      credentialId={null}
      newCredential={draft}
      onBack={onBack}
      discoverWith={{ inlineApiKey: draft.apiKey, baseUrl: draft.baseUrlOverride ?? "" }}
      tickAll
      hasDefault={modelsQuery.data.some((m) => m.is_default)}
      submitLabel={t("credentials.add")}
      onClose={onClose}
    />
  );
}
