// SPDX-License-Identifier: Apache-2.0

/**
 * The two forms of a configuration itself: « Ajouter une configuration » (a service of the
 * registry; a gateway's endpoint; its label; whether members may connect their own) and a
 * gateway's « Modifier l'endpoint ». A service that already has its configuration is not made
 * twice: the form offers to open it, and so does the server's `409 model_config_exists`.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Switch } from "@appstrate/ui/components/switch";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { FormItem } from "@/components/app-ui/form-item";
import { useAppForm } from "../../hooks/use-app-form";
import { useCreateModelConfig, useUpdateModelConfig } from "../../hooks/use-model-configs";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials";
import { parsesAsUrl } from "../../lib/model-discovery";
import {
  configUpdateBody,
  createConfigBody,
  existingConfigFor,
  existingConfigIdOf,
  type ModelConfigInfo,
} from "../../lib/model-configs";
import { errorMessage } from "../../lib/mutation-error";
import { getProviderById } from "../../lib/provider-registry-helpers";
import { FormModal } from "../form-modal";
import { SettingRow } from "../settings/setting-row";
import { EndpointFields } from "../model-form/endpoint-fields";
import { ProviderPicker } from "../model-form/provider-picker";

interface AddFields {
  label: string;
  baseUrl: string;
}

export function AddModelConfigDialog({
  registry,
  configs,
  onClose,
  onCreated,
  onOpenExisting,
}: {
  registry: readonly ProviderRegistryEntry[];
  configs: readonly ModelConfigInfo[];
  onClose: () => void;
  /** The new configuration: its models are chosen next. */
  onCreated: (config: ModelConfigInfo) => void;
  /** A service already configured: its row opens instead. */
  onOpenExisting: (configId: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const create = useCreateModelConfig({ errorHandledByCaller: true });
  const [providerId, setProviderId] = useState("");
  const [personalAllowed, setPersonalAllowed] = useState(true);
  const provider = getProviderById(providerId, registry);
  const existing = provider ? existingConfigFor(configs, provider) : undefined;
  const gateway = provider?.baseUrlOverridable === true;

  const {
    register,
    handleSubmit,
    setValue,
    showError,
    formState: { errors },
  } = useAppForm<AddFields>({ defaultValues: { label: "", baseUrl: "" } });

  const pick = (id: string) => {
    const next = getProviderById(id, registry);
    setProviderId(id);
    create.reset();
    setValue("baseUrl", next?.baseUrlOverridable ? next.defaultBaseUrl : "");
  };

  const onSubmit = handleSubmit((data) => {
    if (!provider || existing) return;
    create.mutate(
      {
        body: createConfigBody({
          provider,
          label: data.label,
          baseUrl: data.baseUrl,
          personalConnectionsAllowed: personalAllowed,
        }),
      },
      {
        onSuccess: (config) => onCreated(config),
        onError: (err) => {
          const id = existingConfigIdOf(err);
          if (id) onOpenExisting(id);
        },
      },
    );
  });

  const baseUrlValidate = (v: string) => {
    if (!gateway) return undefined;
    if (!v.trim()) return t("validation.required", { ns: "common" });
    return parsesAsUrl(v) ? undefined : t("validation.urlFormat", { ns: "common" });
  };

  return (
    <FormModal
      onClose={onClose}
      title={t("modelConfigs.add.title")}
      onSubmit={onSubmit}
      error={create.error && !existingConfigIdOf(create.error) ? errorMessage(create.error) : null}
      isPending={create.isPending}
      submitLabel={t("modelConfigs.add.submit")}
      submitDisabled={!provider || !!existing}
      formProps={{ noValidate: true }}
    >
      <FormItem id="cfg-provider" label={t("modelConfigs.add.service")}>
        <ProviderPicker
          id="cfg-provider"
          registry={registry}
          providerId={providerId}
          disabled={false}
          onChange={pick}
        />
      </FormItem>

      {existing && (
        <Alert
          size="sm"
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onOpenExisting(existing.id)}
            >
              {t("modelConfigs.add.openExisting")}
            </Button>
          }
        >
          <AlertDescription>
            {t("modelConfigs.add.exists", { label: existing.label })}
          </AlertDescription>
        </Alert>
      )}

      {provider && !existing && (
        <>
          <EndpointFields
            idPrefix="cfg"
            providers={registry.filter((p) => p.baseUrlOverridable)}
            provider={provider}
            onApiTypeChange={(entry) => pick(entry.providerId)}
            baseUrlProps={register("baseUrl", { validate: baseUrlValidate })}
            baseUrlError={showError("baseUrl") ? errors.baseUrl?.message : undefined}
          />
          <FormItem
            id="cfg-label"
            label={t("modelConfigs.add.label")}
            hint={t("modelConfigs.add.labelHint")}
          >
            <Input type="text" {...register("label")} placeholder={provider.displayName} />
          </FormItem>
          <SettingRow
            variant="toggle"
            className="pb-0"
            label={
              <Label htmlFor="cfg-personal" className="cursor-pointer">
                {t("modelConfigs.add.personal")}
              </Label>
            }
            description={t("modelConfigs.connections.personalHint")}
          >
            <Switch
              id="cfg-personal"
              checked={personalAllowed}
              onCheckedChange={(checked) => setPersonalAllowed(checked)}
            />
          </SettingRow>
        </>
      )}
    </FormModal>
  );
}

/** « Modifier l'endpoint » of a gateway configuration: its URL; its API type stays. */
export function ModelConfigEndpointDialog({
  config,
  registry,
  onClose,
}: {
  config: ModelConfigInfo;
  registry: readonly ProviderRegistryEntry[];
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const update = useUpdateModelConfig({ errorHandledByCaller: true });
  const provider = getProviderById(config.provider_id, registry);
  const {
    register,
    handleSubmit,
    showError,
    formState: { errors },
  } = useAppForm<{ baseUrl: string }>({ defaultValues: { baseUrl: config.base_url ?? "" } });

  const onSubmit = handleSubmit((data) =>
    update.mutate(
      { params: { path: { id: config.id } }, body: configUpdateBody({ baseUrl: data.baseUrl }) },
      { onSuccess: onClose },
    ),
  );

  return (
    <FormModal
      onClose={onClose}
      title={t("modelConfigs.endpoint.title", { label: config.label })}
      onSubmit={onSubmit}
      error={update.error ? errorMessage(update.error) : null}
      isPending={update.isPending}
      formProps={{ noValidate: true }}
    >
      <EndpointFields
        idPrefix="cfg-endpoint"
        providers={provider ? [provider] : []}
        provider={provider}
        onApiTypeChange={() => {}}
        providerLocked
        baseUrlProps={register("baseUrl", {
          validate: (v) =>
            !v.trim()
              ? t("validation.required", { ns: "common" })
              : parsesAsUrl(v)
                ? undefined
                : t("validation.urlFormat", { ns: "common" }),
        })}
        baseUrlError={showError("baseUrl") ? errors.baseUrl?.message : undefined}
      />
    </FormModal>
  );
}
