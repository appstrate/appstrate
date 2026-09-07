// SPDX-License-Identifier: Apache-2.0

/**
 * Adding or editing a model, in one arrangement for every provider: pick the
 * provider, describe the endpoint it runs on, then pick or type the model.
 *
 * Only two registry facts change what renders. `baseUrlOverridable` decides
 * whether the endpoint is the operator's to describe; `authMode` decides
 * whether it is opened with a key or a connection. Everything else — which
 * listing fills the model list — is the derived `modelSource`.
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
import { parsesAsUrl, type DiscoveryState } from "@/lib/model-discovery";
import {
  buildModelFormPayload,
  type ModelFormFields,
  type ModelFormSubmit,
} from "@/lib/model-form-payload";
import { buildModelsBatchPayload } from "@/lib/model-pick-payload";
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
 * The form itself, without the dialog chrome — `ModelFormModal` owns the
 * `<Modal>`, its title and its footer buttons (which submit through
 * `form="model-form"`). Exported so the rendered form can be asserted on: a
 * Radix dialog renders nothing at all without a DOM.
 *
 * The catalog is awaited rather than defaulted: the capabilities toggle opens
 * on a comparison against the edited row's registry entry, so a form built
 * before the registry lands would answer that question wrong.
 */
export function ModelFormBody(props: ModelFormBodyProps) {
  const registryQuery = useProvidersRegistry();
  if (registryQuery.error) return <ErrorState message={getErrorMessage(registryQuery.error)} />;
  if (!registryQuery.data) return <LoadingState />;
  return <ModelForm {...props} registry={registryQuery.data} />;
}

function ModelForm({
  model,
  onSubmit,
  onMultiSelectionChange,
  registry,
}: ModelFormBodyProps & { registry: readonly ProviderRegistryEntry[] }) {
  const { t } = useTranslation(["settings", "common"]);

  // A row's provider is its credential's, and every non-aliased row carries it;
  // aliases hide their binding and the models page refuses to edit them.
  const [providerId, setProviderId] = useState(model?.providerId ?? "");
  const selectedProvider = useMemo(
    () => getProviderById(providerId, registry),
    [registry, providerId],
  );
  const overridable = selectedProvider?.baseUrlOverridable === true;
  const isOauth = selectedProvider?.authMode === "oauth2";
  const source = modelSource(selectedProvider);

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
      capabilitiesExplicit:
        !!model &&
        rowOverridesCatalog(
          model,
          selectedProvider?.models.find((m) => m.id === model.modelId),
        ),
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

  // Which saved keys the picked provider can bind to — the whole rule lives in
  // `lib/model-credential-filter.ts`.
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

  // "Ask the endpoint what it serves." Persists nothing, so the listing lives
  // here for this form-open — and only for what it was run against, which
  // `discoveryKey` pins: editing the URL, the key or the provider makes it
  // stale rather than offering ids from an endpoint the form left behind.
  const discoverModels = useDiscoverModels();
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);
  const discoveryKey = [providerId, baseUrl.trim(), credentialId, inlineApiKey.trim()].join("|");
  const freshDiscovery = discovery?.key === discoveryKey ? discovery : null;

  // A subscription's served ids, asked of the live credential — its plan drifts
  // while the credential does not. Only asked where a catalog is filtered by it.
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
    // Exactly what the listing reported, in catalog order-independent form: a
    // served id the catalog never heard of stays offered as an id-only row.
    const byId = new Map(rows.map((r) => [r.id, r]));
    return (served.modelIds ?? []).map((id) => byId.get(id) ?? idOnlyRow(id));
  }, [selectedProvider, source, isOauth, search.models, freshDiscovery, served.modelIds]);

  // A remote search filters itself; the other two are filtered here.
  const rows = source === "search" ? allRows : filterRows(allRows, search.search);

  /** The rows checked so far — kept whole, so a filtered-out pick still ships. */
  const [picked, setPicked] = useState<ModelPickRow[]>([]);
  /** Ids a batch could not create — re-offered instead of silently dropped. */
  const [failedModelIds, setFailedModelIds] = useState<string[]>([]);
  /**
   * The credential a partially failed batch already created: a retry binds to
   * it rather than posting the same inline key a second time.
   */
  const [createdCredentialId, setCreatedCredentialId] = useState<string | null>(null);
  const [modelMode, setModelMode] = useState<"list" | "manual" | null>(null);

  // An existing row already names a model, so an edit is always the typed-in
  // arrangement. A create opens on the list wherever one is free to show.
  const mode = model ? "manual" : (modelMode ?? (source === "discover" ? null : "list"));
  const manual = endpointReady && mode === "manual";
  // A catalog is free and a search is typed, so both show the list at once and
  // state their own waiting or empty inside it. Discovery has to be asked for.
  const listing =
    endpointReady && !model && mode === "list" && (source !== "discover" || allRows.length > 0);
  /** oauth2 has no manual answer: the seed gate refuses an unserved id. */
  const offersManual = !isOauth;

  useEffect(() => {
    onMultiSelectionChange?.(listing ? picked.length : null);
  }, [listing, picked.length, onMultiSelectionChange]);

  /** A listing belongs to the endpoint it ran against, and to nothing else. */
  const dropListing = () => {
    setPicked([]);
    setFailedModelIds([]);
    setCreatedCredentialId(null);
  };

  const resetModelStep = () => {
    setValue("label", "");
    setValue("modelId", "");
    setValue("capabilitiesExplicit", false);
    setValue("inputText", true);
    setValue("inputImage", false);
    setValue("contextWindow", "");
    setValue("maxTokens", "");
    setValue("reasoning", false);
    setModelMode(null);
    search.setSearch("");
    dropListing();
  };

  const handleProviderChange = (id: string) => {
    setProviderId(id);
    clearErrors();
    // The credential belongs to the provider it was picked for — carrying it
    // over would bind the model to the endpoint the operator just left.
    setValue("credentialId", "");
    setValue("inlineApiKey", "");
    const provider = getProviderById(id, registry);
    if (provider) {
      setValue("apiShape", provider.apiShape);
      // Pre-seeded even when overridable: the operator edits the value they are
      // customising rather than typing a whole URL from scratch.
      setValue("baseUrl", provider.defaultBaseUrl);
    }
    resetModelStep();
  };

  // Switching the wire format re-points the endpoint, not the secret: the URL
  // follows the new entry and the typed key stays. A saved credential pins both,
  // and the model was named by a listing this endpoint no longer serves.
  const handleApiTypeChange = (entry: ProviderRegistryEntry) => {
    setProviderId(entry.providerId);
    clearErrors();
    setValue("apiShape", entry.apiShape);
    setValue("baseUrl", entry.defaultBaseUrl);
    setValue("credentialId", "");
    resetModelStep();
  };

  const existingKeys = {
    items: availableCredentials,
    selected: selectedCredential ?? null,
    onSelect: (id: string) => {
      setValue("credentialId", id);
      setValue("inlineApiKey", "");
      clearErrors("credentialId");
      // The key carries the endpoint it was saved against — the form follows it
      // there (and pins the field) instead of asking for the URL again.
      const key = availableCredentials.find((k) => k.id === id);
      if (key?.baseUrl) setValue("baseUrl", key.baseUrl);
      dropListing();
    },
    onClear: () => {
      setValue("credentialId", "");
      setValue("inlineApiKey", "");
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
    // A re-run describes the endpoint again: nothing checked carries over.
    dropListing();
    discoverModels.mutate(
      {
        body: selectedCredential
          ? { credential_id: selectedCredential.id }
          : {
              provider_id: selectedProvider.providerId,
              api_key: inlineApiKey.trim(),
              ...(overridable ? { base_url_override: baseUrl.trim() } : {}),
            },
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
      if (!outcome || outcome.failedModelIds.length === 0) return;
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
    });
    if (!result.ok) {
      setError(result.field, { message: t(result.messageKey) });
      return;
    }
    onSubmit(result.data);
  });

  // Creating, an empty name lets the server derive one. Editing, PUT reads an
  // absent name as "keep it", so clearing it is refused rather than saved.
  const labelValidate = (v: string) =>
    !model || v.trim() ? undefined : t("validation.required", { ns: "common" });
  const baseUrlValidate = (v: string) =>
    !overridable || parsesAsUrl(v) ? undefined : t("validation.required", { ns: "common" });
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
        // The endpoint belongs to the saved row; changing it would rebind the
        // model to a service it was never verified against.
        disabled={!!model}
        onChange={handleProviderChange}
      />

      <EndpointFields
        idPrefix="mdl"
        provider={selectedProvider}
        providers={registry.filter((p) => p.baseUrlOverridable)}
        onApiTypeChange={handleApiTypeChange}
        providerLocked={!!model}
        baseUrlProps={register("baseUrl", { validate: baseUrlValidate, onChange: dropListing })}
        // The URL is a property of the credential (`baseUrlOverride`), not of
        // the model, so it only moves when a credential is created with it.
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
            isLoading={source === "search" ? search.isLoading : isOauth && served.modelIds === null}
            loadingText={
              source === "search"
                ? t("models.form.modelSearchLoading")
                : t("models.form.detectingModels")
            }
            emptyText={
              isOauth && !search.search.trim()
                ? t("models.form.noModelsDetected")
                : t("models.form.modelSearchEmpty")
            }
            grouped={source === "catalog"}
          />
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

      {/* Registered even where no arrangement puts it on screen — an id nothing
          validates turns saving too early into a dead button. */}
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
              setValue("credentialId", newId);
              setValue("inlineApiKey", "");
              clearErrors("credentialId");
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

/**
 * The dialog around the form. Mounted only while open, so the selection count
 * its footer reads starts empty on every open — the body owns which models are
 * checked, this owns the button that adds them.
 */
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
