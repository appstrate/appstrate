// SPDX-License-Identifier: Apache-2.0

/**
 * Adding or editing a model, in one arrangement for every provider: pick the
 * provider, describe the endpoint it runs on, then pick or type the model.
 * Two registry facts change what renders: `baseUrlOverridable` (is the
 * endpoint the operator's to describe) and `authMode` (key or connection);
 * which listing fills the model list is the derived `modelSource`.
 */

import { useEffect, useMemo, useState } from "react";
import { useWatch } from "react-hook-form";
import { useAppForm } from "../hooks/use-app-form";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";
import { Label } from "@appstrate/ui/components/label";
import { type OrgModelInfo } from "../hooks/use-models";
import { DiscoveryControls } from "./model-form/discovery-controls";
import { EndpointFields } from "./model-form/endpoint-fields";
import { ManualModelFields } from "./model-form/manual-model-fields";
import { ModelPickList } from "./model-form/model-pick-list";
import { ProviderPicker } from "./model-form/provider-picker";
import { useOpenRouterSearch } from "./model-form/use-open-router-search";
import {
  useDiscoverModels,
  useModelProviderCredentials,
  useProvidersRegistry,
  type ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import { useServedModels } from "../hooks/use-served-models";
import { OAuthPairingBody } from "./oauth-pairing-body";
import { usePairingDismissConfirm } from "../hooks/use-pairing-dismiss-confirm";
import { ErrorState, LoadingState } from "./page-states";
import { getErrorMessage } from "@appstrate/core/errors";
import { getProviderById } from "@/lib/provider-registry-helpers";
import { buildDiscoverBody, parsesAsUrl, type DiscoveryState } from "@/lib/model-discovery";
import {
  buildModelFormPayload,
  buildModelsBatchPayload,
  type ModelFormFields,
  type ModelFormSubmit,
} from "@/lib/model-form-payload";
import {
  catalogRows,
  discoveredRows,
  filterRows,
  idOnlyRow,
  modelSource,
  searchRows,
  type ModelPickRow,
} from "@/lib/model-source";
import { rowOverridesCatalog } from "@/lib/row-overrides-catalog";
import { selectableCredentials } from "@/lib/model-credential-filter";

interface ModelFormModalProps {
  open: boolean;
  onClose: () => void;
  model: OrgModelInfo | null;
  isPending: boolean;
  onSubmit: ModelFormSubmit;
}

interface ModelFormBodyProps {
  model: OrgModelInfo | null;
  onSubmit: ModelFormSubmit;
  /** How many models the pick list has checked; `null` = single model. */
  onMultiSelectionChange?: (count: number | null) => void;
}

/**
 * The form without the dialog chrome (a Radix dialog renders nothing without
 * a DOM). The registry is awaited, not defaulted: the capabilities toggle
 * opens on a comparison against the edited row's catalog entry.
 */
export function ModelFormBody(props: ModelFormBodyProps) {
  const { t } = useTranslation(["settings", "common"]);
  const registryQuery = useProvidersRegistry();
  if (registryQuery.error) return <ErrorState message={getErrorMessage(registryQuery.error)} />;
  if (!registryQuery.data) return <LoadingState />;
  // A row whose provider left the registry has no endpoint to describe and no
  // credential to match: say so rather than render an empty form.
  if (props.model && !getProviderById(props.model.providerId ?? "", registryQuery.data)) {
    return <ErrorState message={t("models.form.providerUnavailable")} />;
  }
  return <ModelForm {...props} registry={registryQuery.data} />;
}

function ModelForm({
  model,
  onSubmit,
  onMultiSelectionChange,
  registry,
}: ModelFormBodyProps & { registry: readonly ProviderRegistryEntry[] }) {
  const { t } = useTranslation(["settings", "common"]);

  // Every non-aliased row carries its credential's providerId; aliases hide
  // their binding and the models page refuses to edit them.
  const [providerId, setProviderId] = useState(model?.providerId ?? "");
  const selectedProvider = useMemo(
    () => getProviderById(providerId, registry),
    [registry, providerId],
  );
  const overridable = selectedProvider?.baseUrlOverridable === true;
  const isOauth = selectedProvider?.authMode === "oauth2";
  const source = modelSource(selectedProvider);

  /** The catalog's own values for an id: read by the toggle's opening state and by the payload. */
  const catalogEntry = (id: string | null | undefined) =>
    id ? selectedProvider?.models.find((m) => m.id === id) : undefined;

  const {
    register,
    handleSubmit,
    control,
    setValue,
    setError,
    clearErrors,
    showError,
    formState: { errors, dirtyFields },
  } = useAppForm<ModelFormFields>({
    defaultValues: {
      label: model?.label ?? "",
      apiShape: model?.apiShape ?? "",
      baseUrl: model?.baseUrl ?? "",
      modelId: model?.modelId ?? "",
      credentialId: model?.credentialId ?? "",
      inlineApiKey: "",
      capabilitiesExplicit: !!model && rowOverridesCatalog(model, catalogEntry(model.modelId)),
      inputText: model?.input?.includes("text") !== false,
      inputImage: model?.input?.includes("image") ?? false,
      contextWindow: model?.contextWindow?.toString() ?? "",
      maxTokens: model?.maxTokens?.toString() ?? "",
      reasoning: model?.reasoning ?? false,
    },
  });

  const [
    apiShape,
    baseUrl,
    credentialId,
    inlineApiKey,
    capabilitiesExplicit,
    inputText,
    inputImage,
    reasoning,
  ] = useWatch({
    control,
    name: [
      "apiShape",
      "baseUrl",
      "credentialId",
      "inlineApiKey",
      "capabilitiesExplicit",
      "inputText",
      "inputImage",
      "reasoning",
    ],
  });

  const credentialsQuery = useModelProviderCredentials();
  const availableCredentials = useMemo(
    () =>
      selectableCredentials({
        credentials: credentialsQuery.data,
        provider: selectedProvider,
        apiShape,
        baseUrl,
      }),
    [credentialsQuery.data, selectedProvider, apiShape, baseUrl],
  );
  const selectedCredential = availableCredentials.find((k) => k.id === credentialId);

  const [oauthDialogOpen, setOauthDialogOpen] = useState(false);
  const oauthDismiss = usePairingDismissConfirm(() => setOauthDialogOpen(false));

  /** Step 1 answered: an endpoint that parses, and something that opens it. */
  const endpointReady =
    !!selectedProvider &&
    (!!selectedCredential || (!isOauth && !!inlineApiKey.trim())) &&
    (!overridable || parsesAsUrl(baseUrl));

  // Discovery persists nothing, so the listing lives here — and only for what
  // it ran against: editing the URL, the key or the provider makes it stale.
  const discoverModels = useDiscoverModels();
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);
  const discoveryKey = [providerId, baseUrl.trim(), credentialId, inlineApiKey.trim()].join("|");
  const freshDiscovery = discovery?.key === discoveryKey ? discovery : null;

  const served = useServedModels(!model && isOauth && source === "catalog" ? credentialId : null);
  const search = useOpenRouterSearch(source === "search");

  const allRows = useMemo((): ModelPickRow[] => {
    if (!selectedProvider) return [];
    if (source === "search") return searchRows(search.models);
    if (source === "discover") {
      return freshDiscovery?.outcome === "ok" ? discoveredRows(freshDiscovery.models) : [];
    }
    const rows = catalogRows(selectedProvider.models);
    if (!isOauth) return rows;
    // Exactly what the plan serves; an id the catalog lacks stays offered id-only.
    const byId = new Map(rows.map((r) => [r.id, r]));
    return (served.modelIds ?? []).map((id) => byId.get(id) ?? idOnlyRow(id));
  }, [selectedProvider, source, isOauth, search.models, freshDiscovery, served.modelIds]);

  const rows = source === "search" ? allRows : filterRows(allRows, search.search);

  /** The rows checked so far — kept whole, so a filtered-out pick still ships. */
  const [picked, setPicked] = useState<ModelPickRow[]>([]);
  /** Ids a batch could not create — re-offered instead of silently dropped. */
  const [failedModelIds, setFailedModelIds] = useState<string[]>([]);
  /** The credential a partially failed batch already created: a retry binds to it. */
  const [createdCredentialId, setCreatedCredentialId] = useState<string | null>(null);
  const [modelMode, setModelMode] = useState<"list" | "manual" | null>(null);

  // An edit always types the id in. A create opens on the list wherever one is
  // free to show; discovery has to be asked for.
  const mode = model ? "manual" : (modelMode ?? (source === "discover" ? null : "list"));
  const manual = endpointReady && mode === "manual";
  const listing =
    endpointReady && !model && mode === "list" && (source !== "discover" || allRows.length > 0);
  // A subscription only answers for what its plan serves: an id it does not
  // carry saves fine and then fails every run.
  const offersManual = !isOauth;

  useEffect(() => {
    onMultiSelectionChange?.(listing ? picked.length : null);
  }, [listing, picked.length, onMultiSelectionChange]);

  const dropListing = () => {
    setPicked([]);
    setFailedModelIds([]);
    setCreatedCredentialId(null);
  };

  const resetModelStep = () => {
    setValue("label", "");
    setValue("modelId", "");
    clearErrors("modelId");
    setValue("capabilitiesExplicit", false);
    setValue("inputText", true);
    setValue("inputImage", false);
    setValue("contextWindow", "");
    setValue("maxTokens", "");
    setValue("reasoning", false);
    setModelMode(null);
    search.reset();
    dropListing();
  };

  /** A typed key never coexists with a saved credential. */
  const bindCredential = (id: string) => {
    setValue("credentialId", id);
    setValue("inlineApiKey", "");
    clearErrors("credentialId");
  };

  /**
   * A saved credential belongs to the provider it was picked for; a typed key
   * survives only the API-type switch, which re-points the endpoint, not the
   * secret.
   */
  const switchProvider = (id: string, keepTypedKey: boolean) => {
    setProviderId(id);
    clearErrors();
    setValue("credentialId", "");
    if (!keepTypedKey) setValue("inlineApiKey", "");
    const provider = getProviderById(id, registry);
    if (provider) {
      setValue("apiShape", provider.apiShape);
      // Pre-seeded even when overridable: the operator edits, not retypes.
      setValue("baseUrl", provider.defaultBaseUrl);
    }
    resetModelStep();
  };

  const existingKeys = {
    items: availableCredentials,
    selected: selectedCredential ?? null,
    onSelect: (id: string) => {
      bindCredential(id);
      // The key carries the endpoint it was saved against; the form follows it there.
      const key = availableCredentials.find((k) => k.id === id);
      if (key?.baseUrl) setValue("baseUrl", key.baseUrl);
      dropListing();
    },
    onClear: () => {
      bindCredential("");
      dropListing();
    },
  };

  const switchMode = (next: "list" | "manual") => {
    if (mode !== next) resetModelStep();
    setModelMode(next);
  };

  const handleDiscover = () => {
    if (!selectedProvider) return;
    const key = discoveryKey;
    switchMode("list");
    dropListing();
    discoverModels.mutate(
      {
        body: buildDiscoverBody({
          credentialId: selectedCredential?.id ?? null,
          provider: selectedProvider,
          inlineApiKey,
          baseUrl,
        }),
      },
      {
        onSuccess: (data) => setDiscovery({ key, outcome: data.outcome, models: data.models }),
        onError: () => setDiscovery({ key, outcome: "request_failed", models: [] }),
      },
    );
  };

  const handleSelectionChange = (changed: ModelPickRow[], checked: boolean) => {
    const ids = new Set(changed.map((r) => r.id));
    const kept = picked.filter((r) => !ids.has(r.id));
    setPicked(checked ? [...kept, ...changed] : kept);
  };

  const onFormSubmit = handleSubmit(async (data) => {
    if (listing) {
      const batch = buildModelsBatchPayload({
        rows: picked,
        provider: selectedProvider,
        selectedCredentialId: selectedCredential?.id ?? createdCredentialId,
        inlineApiKey: data.inlineApiKey,
        baseUrl: data.baseUrl,
      });
      if (!batch.ok) {
        setError(batch.field, { message: t(batch.messageKey) });
        return;
      }
      const outcome = await onSubmit(batch.data);
      if (outcome.failedModelIds.length === 0) return;
      if (outcome.credentialId) setCreatedCredentialId(outcome.credentialId);
      setFailedModelIds(outcome.failedModelIds);
      // Only what failed stays checked — the rest are rows in the table now.
      setPicked(picked.filter((r) => outcome.failedModelIds.includes(r.id)));
      return;
    }
    const result = buildModelFormPayload({
      fields: data,
      dirtyFields,
      provider: selectedProvider,
      selectedCredentialId: selectedCredential?.id ?? null,
      capabilities: capabilitiesExplicit ? "explicit" : "auto",
      isEdit: !!model,
      catalogEntry: catalogEntry(data.modelId.trim()),
    });
    if (!result.ok) {
      setError(result.field, { message: t(result.messageKey) });
      return;
    }
    // The host closes on success and reports nothing here.
    const outcome = await onSubmit(result.data);
    if (outcome.failedModelIds.length > 0) {
      setError("modelId", { message: t("models.form.saveFailed") });
    }
  });

  // Creating, an empty name lets the server derive one. Editing, PUT reads an
  // absent name as "keep it", so clearing it is refused.
  const labelValidate = (v: string) =>
    !model || v.trim() ? undefined : t("validation.required", { ns: "common" });
  const baseUrlValidate = (v: string) => {
    if (!overridable || parsesAsUrl(v)) return undefined;
    return t(v.trim() ? "validation.urlFormat" : "validation.required", { ns: "common" });
  };
  // An empty id with no arrangement to type it in names the steps, not the field.
  const modelIdValidate = (v: string) =>
    v.trim()
      ? undefined
      : manual
        ? t("validation.required", { ns: "common" })
        : t("models.form.modelStepRequired");

  const modelIdError =
    showError("modelId") && errors.modelId?.message ? (
      <div className="text-destructive text-sm">{errors.modelId.message}</div>
    ) : null;

  const manualToggle = (next: "list" | "manual") => (
    <Button type="button" variant="outline" onClick={() => switchMode(next)}>
      {next === "manual" ? t("models.form.manualButton") : t("models.form.pickFromList")}
    </Button>
  );

  return (
    <form id="model-form" onSubmit={onFormSubmit} className="space-y-4">
      <ProviderPicker
        id="mdl-provider"
        registry={registry}
        providerId={providerId}
        // The endpoint belongs to the saved row.
        disabled={!!model}
        onChange={(id) => switchProvider(id, false)}
      />

      <EndpointFields
        idPrefix="mdl"
        provider={selectedProvider}
        providers={registry.filter((p) => p.baseUrlOverridable)}
        onApiTypeChange={(entry) => switchProvider(entry.providerId, true)}
        providerLocked={!!model}
        baseUrlProps={register("baseUrl", { validate: baseUrlValidate, onChange: dropListing })}
        // The URL is a property of the credential, not of the model.
        baseUrlLocked={!!selectedCredential}
        baseUrlError={showError("baseUrl") ? errors.baseUrl?.message : undefined}
        apiKeyProps={register("inlineApiKey", { onChange: dropListing })}
        apiKeyError={showError("credentialId") ? errors.credentialId?.message : undefined}
        apiKeyHint={
          !selectedCredential && inlineApiKey.trim()
            ? t("models.form.createCredentialHint")
            : undefined
        }
        existingKeys={existingKeys}
        onConnect={() => setOauthDialogOpen(true)}
      />

      {endpointReady && source === "discover" && !model && (
        <DiscoveryControls
          mode={mode}
          discovery={freshDiscovery}
          isPending={discoverModels.isPending}
          onDiscover={handleDiscover}
          onManual={() => switchMode("manual")}
        />
      )}

      {listing && (
        <div className="space-y-2">
          <Label>{t("models.form.modelId")}</Label>
          <ModelPickList
            rows={rows}
            selectedIds={picked.map((r) => r.id)}
            onSelectionChange={handleSelectionChange}
            search={search.search}
            onSearchChange={search.setSearch}
            isLoading={
              source === "search"
                ? search.isLoading
                : isOauth && served.modelIds === null && !served.failed
            }
            loadingText={
              source === "search"
                ? t("models.form.modelSearchLoading")
                : t("models.form.detectingModels")
            }
            // A refusal is not an empty plan.
            emptyText={
              isOauth && served.failed
                ? t("models.form.discoverRequestFailed")
                : isOauth && !search.search.trim()
                  ? t("models.form.noModelsDetected")
                  : t("models.form.modelSearchEmpty")
            }
            grouped={source === "catalog"}
          />
          {isOauth && served.failed && (
            <Button type="button" variant="outline" onClick={served.retry}>
              {t("models.form.discoverButton")}
            </Button>
          )}
          {modelIdError}
          {failedModelIds.length > 0 && (
            <div className="text-destructive text-sm">
              {t("models.form.addFailed", { ids: failedModelIds.join(", ") })}
            </div>
          )}
          {source !== "discover" && offersManual && manualToggle("manual")}
        </div>
      )}

      {manual && (
        <>
          <ManualModelFields
            idPrefix="mdl"
            modelIdProps={register("modelId", { validate: modelIdValidate })}
            modelIdError={showError("modelId") ? errors.modelId?.message : undefined}
            labelProps={register("label", { validate: labelValidate })}
            labelError={showError("label") ? errors.label?.message : undefined}
            labelPlaceholder={model ? undefined : t("models.form.labelPlaceholder")}
            capabilities={{
              explicit: capabilitiesExplicit,
              contextWindowProps: register("contextWindow"),
              maxTokensProps: register("maxTokens"),
              inputText,
              inputImage,
              reasoning,
              onExplicitChange: (v) => setValue("capabilitiesExplicit", v),
              onInputTextChange: (v) => setValue("inputText", v),
              onInputImageChange: (v) => setValue("inputImage", v),
              onReasoningChange: (v) => setValue("reasoning", v),
            }}
          />
          {!model && source !== "discover" && offersManual && manualToggle("list")}
        </>
      )}

      {/* Registered even off screen, so saving too early is refused, not a dead button. */}
      {!manual && !listing && (
        <>
          <input type="hidden" {...register("modelId", { validate: modelIdValidate })} />
          {modelIdError}
        </>
      )}

      {oauthDialogOpen && (
        <Modal
          open
          onClose={oauthDismiss.requestClose}
          title={t("credentials.oauth.cliStageTitle")}
          actions={
            <Button variant="ghost" onClick={oauthDismiss.requestClose}>
              {t("credentials.oauth.close")}
            </Button>
          }
        >
          <OAuthPairingBody
            providerId={providerId}
            onConnected={(newId) => {
              bindCredential(newId);
              setOauthDialogOpen(false);
            }}
            onBusyChange={oauthDismiss.onBusyChange}
          />
        </Modal>
      )}
      {oauthDismiss.confirmDialog}
    </form>
  );
}

/** Mounted only while open, so the footer's selection count starts empty on every open. */
function ModelFormDialog({
  onClose,
  model,
  isPending,
  onSubmit,
}: Omit<ModelFormModalProps, "open">) {
  const { t } = useTranslation(["settings", "common"]);
  const [selectionCount, setSelectionCount] = useState<number | null>(null);

  return (
    <Modal
      open
      onClose={onClose}
      title={model ? t("models.form.editTitle") : t("models.form.title")}
      actions={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button type="submit" form="model-form" disabled={isPending || selectionCount === 0}>
            {isPending ? (
              <Spinner />
            ) : selectionCount !== null ? (
              t("models.form.addModels", { count: selectionCount })
            ) : (
              t("btn.save")
            )}
          </Button>
        </>
      }
    >
      {/* Key forces remount when the target model changes, resetting all state */}
      <ModelFormBody
        key={model?.id ?? "__create__"}
        model={model}
        onSubmit={onSubmit}
        onMultiSelectionChange={setSelectionCount}
      />
    </Modal>
  );
}

export function ModelFormModal({ open, ...props }: ModelFormModalProps) {
  if (!open) return null;
  return <ModelFormDialog {...props} />;
}
