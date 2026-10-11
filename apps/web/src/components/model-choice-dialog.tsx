// SPDX-License-Identifier: Apache-2.0

/**
 * The dialog around « Choose the models »: an organization key's, the personal keys' per
 * service, and the second step of « Add a provider ». The list is `ModelChoiceList`; this owns
 * the footer, the write (`useApplyModelChoice`) and the refusals it can name.
 */

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { Label } from "@appstrate/ui/components/label";
import { Modal } from "./modal";
import { Spinner } from "./spinner";
import { ErrorState, LoadingState } from "./page-states";
import { ModelChoiceList } from "./model-choice";
import { useModelChoice, type DiscoverWith } from "../hooks/use-model-choice-state";
import { useApplyModelChoice, type NewProviderCredential } from "../hooks/use-model-choice";
import {
  useProvidersRegistry,
  type ModelProviderCredentialInfo,
  type ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import { useModels, type OrgModelInfo } from "../hooks/use-models";
import { errorMessage } from "../lib/mutation-error";
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
  /** « Add a provider »: the key to mint with the models, and the way back to its form. */
  newCredential?: NewProviderCredential;
  onBack?: () => void;
  discoverWith: DiscoverWith;
  tickAll: boolean;
  allowDefault: boolean;
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
  existing,
  credentialId,
  newCredential,
  onBack,
  discoverWith,
  tickAll,
  allowDefault,
  hasDefault,
  submitLabel,
  onClose,
  onAdvanced,
  header,
}: ChoiceDialogProps) {
  const { t } = useTranslation(["settings", "common"]);
  const choice = useModelChoice({
    provider,
    existing,
    discoverWith,
    tickAll,
    allowDefault,
    hasDefault,
  });
  const { apply, isPending } = useApplyModelChoice();
  // The key a refused submission already minted: a retry binds to it instead of minting a second.
  const [minted, setMinted] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);

  const save = async () => {
    setFailed([]);
    setRefusal(null);
    try {
      const outcome = await apply({
        plan: choice.plan,
        existing,
        target: { credentialId: minted ?? credentialId, providerId: provider.providerId },
        newCredential: minted ? undefined : newCredential,
      });
      if (outcome.credentialId) setMinted(outcome.credentialId);
      if (outcome.failedModelIds.length === 0) onClose();
      else setFailed(outcome.failedModelIds);
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
            disabled={isPending || (!tickAll && !choice.canSave)}
          >
            {isPending ? <Spinner /> : submitLabel}
          </Button>
        </>
      }
    >
      <fieldset disabled={isPending} className="min-w-0 space-y-3">
        {intro && <p className="text-muted-foreground text-sm">{intro}</p>}
        {header}
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
        {refusal && <div className="text-destructive text-sm">{refusal}</div>}
        {failed.length > 0 && (
          <div className="text-destructive text-sm">
            {t("models.choice.failed", { ids: failed.join(", ") })}
          </div>
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
          <LoadingState />
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
      discoverWith={{ credentialId: credential.id }}
      tickAll={false}
      allowDefault
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
}: {
  /** The services a person may serve with a key of their own. */
  services: ProviderRegistryEntry[];
  providerId: string;
  onChangeService: (providerId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const modelsQuery = useModels();
  const provider = services.find((s) => s.providerId === providerId) ?? services[0];

  if (!modelsQuery.data || !provider) {
    return (
      <Modal open onClose={onClose} title={t("models.choice.personalTitle")}>
        {modelsQuery.error ? <ErrorState error={modelsQuery.error} compact /> : <LoadingState />}
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
      existing={memberModels(modelsQuery.data).filter((m) => m.providerId === provider.providerId)}
      credentialId={null}
      discoverWith={null}
      tickAll={false}
      allowDefault={false}
      hasDefault
      submitLabel={t("btn.save")}
      onClose={onClose}
      header={
        <div className="space-y-2">
          <Label htmlFor="personal-models-service">{t("models.form.provider")}</Label>
          <Select value={provider.providerId} onValueChange={onChangeService}>
            <SelectTrigger id="personal-models-service">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {services.map((service) => (
                <SelectItem key={service.providerId} value={service.providerId}>
                  {service.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    />
  );
}

/** Step 2 of « Add a provider »: the models the new key makes available, all ticked. */
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
          <LoadingState />
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
      allowDefault
      hasDefault={modelsQuery.data.some((m) => m.is_default)}
      submitLabel={t("credentials.add")}
      onClose={onClose}
    />
  );
}
