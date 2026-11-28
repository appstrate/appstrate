// SPDX-License-Identifier: Apache-2.0

/**
 * Editing a saved model: its id, its name and its capabilities. The model stays in its
 * configuration, whose connections serve it. Adding models is `ModelChoiceDialog`; this form only
 * changes what exists. `modelSource` decides whether the id must be one the provider's catalog
 * offers.
 */

import { PendingButton } from "@/components/app-ui/pending-button";
import { FormProvider } from "react-hook-form";
import { useAppForm } from "../hooks/use-app-form";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { ApiError } from "../api/errors";
import { useUpdateModel, type OrgModelInfo } from "../hooks/use-models";
import { ManualModelFields } from "./model-form/manual-model-fields";
import { SavedModelActions } from "./model-form/saved-model-actions";
import {
  useProvidersRegistry,
  type ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import { ErrorState } from "./page-states";
import { SettingsSkeleton } from "./loading-skeletons";
import { refusalMessage, validationFieldErrors } from "../lib/mutation-error";
import { getProviderById } from "@/lib/provider-registry-helpers";
import {
  buildModelFormPayload,
  modelFormRefusals,
  type ModelFormData,
  type ModelFormFields,
} from "@/lib/model-form-payload";
import { modelSource } from "@/lib/model-source";
import { rowOverridesCatalog } from "@/lib/row-overrides-catalog";

interface ModelFormBodyProps {
  model: OrgModelInfo;
  /** Rejects when the server refuses the save. */
  onSubmit: (data: ModelFormData) => Promise<unknown>;
}

/**
 * The form without the dialog chrome (a dialog renders nothing without a DOM). The registry
 * is awaited, not defaulted: the capabilities toggle opens on a comparison against the row's
 * catalog entry.
 */
export function ModelFormBody(props: ModelFormBodyProps) {
  const { t } = useTranslation(["settings", "common"]);
  const registryQuery = useProvidersRegistry();
  if (registryQuery.error) return <ErrorState error={registryQuery.error} />;
  if (!registryQuery.data) return <SettingsSkeleton />;
  // A row whose provider left the registry has no catalog to check against: say so rather than
  // render an empty form.
  const provider = getProviderById(props.model.providerId ?? "", registryQuery.data);
  if (!provider) return <ErrorState message={t("models.form.providerUnavailable")} />;
  return <ModelForm {...props} provider={provider} />;
}

function ModelForm({
  model,
  provider,
  onSubmit,
}: ModelFormBodyProps & { provider: ProviderRegistryEntry }) {
  const { t } = useTranslation(["settings", "common"]);
  const catalogEntry = (id: string) => provider.models.find((m) => m.id === id);

  const form = useAppForm<ModelFormFields>({
    defaultValues: {
      label: model.label,
      modelId: model.modelId ?? "",
      capabilitiesExplicit: rowOverridesCatalog(model, catalogEntry(model.modelId ?? "")),
      inputText: model.input?.includes("text") !== false,
      inputImage: model.input?.includes("image") ?? false,
      contextWindow: model.contextWindow?.toString() ?? "",
      maxTokens: model.maxTokens?.toString() ?? "",
      reasoning: model.reasoning ?? false,
    },
  });
  const {
    register,
    handleSubmit,
    setError,
    showError,
    formState: { errors, dirtyFields },
  } = form;
  const refusals = (modelId: string) =>
    modelFormRefusals({
      modelId,
      offeredIds: modelSource(provider) === "catalog" ? provider.models.map((m) => m.id) : null,
    });
  const modelIdValidate = (v: string) => {
    const key = refusals(v).modelId;
    return key ? t(key, { provider: provider.displayName }) : undefined;
  };
  // `PATCH` reads an absent name as "keep it", so clearing it is refused.
  const labelValidate = (v: string) =>
    v.trim() ? undefined : t("validation.required", { ns: "common" });

  const onFormSubmit = handleSubmit(async (data) => {
    const payload = buildModelFormPayload({
      fields: data,
      dirtyFields,
      capabilities: data.capabilitiesExplicit ? "explicit" : "auto",
      catalogEntry: catalogEntry(data.modelId.trim()),
    });
    try {
      await onSubmit(payload);
    } catch (err) {
      // A refusal the server names is said as it is, else the generic line.
      const code =
        err instanceof ApiError ? (validationFieldErrors(err)[0]?.code ?? err.code) : null;
      setError("modelId", {
        message: (code && refusalMessage({ code })) || t("models.form.saveFailed"),
      });
    }
  });

  return (
    <FormProvider {...form}>
      <form id="model-form" onSubmit={onFormSubmit} noValidate className="flex flex-col gap-4">
        <ManualModelFields
          idPrefix="mdl"
          modelIdProps={register("modelId", { validate: modelIdValidate })}
          modelIdError={showError("modelId") ? errors.modelId?.message : undefined}
          labelProps={register("label", { validate: labelValidate })}
          labelError={showError("label") ? errors.label?.message : undefined}
        />
      </form>
    </FormProvider>
  );
}

/** Mounted by the caller while open. */
export function ModelFormModal({
  onClose,
  model,
  onDelete,
}: {
  onClose: () => void;
  model: OrgModelInfo;
  /** Deletes the model, for a caller who may (`models:delete`). */
  onDelete?: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const update = useUpdateModel();

  return (
    <Modal
      onClose={onClose}
      preventClose={update.isPending}
      title={t("models.form.editTitle")}
      actions={
        <>
          <SavedModelActions model={model} onDelete={onDelete} />
          <Button type="button" variant="outline" onClick={onClose} disabled={update.isPending}>
            {t("btn.cancel")}
          </Button>
          <PendingButton type="submit" form="model-form" pending={update.isPending}>
            {t("btn.save")}
          </PendingButton>
        </>
      }
    >
      <fieldset disabled={update.isPending} className="min-w-0">
        <ModelFormBody
          model={model}
          onSubmit={async (body) => {
            await update.mutateAsync({ params: { path: { id: model.id } }, body });
            onClose();
          }}
        />
      </fieldset>
    </Modal>
  );
}
