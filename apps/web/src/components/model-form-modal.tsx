// SPDX-License-Identifier: Apache-2.0

import React, { useState, useMemo, useEffect } from "react";
import { useWatch } from "react-hook-form";
import { useAppForm } from "../hooks/use-app-form";
import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { ProviderPickerGroups } from "./provider-picker-groups";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@appstrate/ui/components/command";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { Check, ChevronDown, ChevronsUpDown, Plug, Server } from "lucide-react";
import { type OrgModelInfo } from "../hooks/use-models";
import type { ModelCost } from "@appstrate/core/module";
import { CapabilitiesSection } from "./model-form/capabilities-section";
import {
  ApiKeyRow,
  BaseUrlField,
  CredentialChip,
  EndpointFields,
} from "./model-form/endpoint-fields";
import { useOpenRouterSearch } from "./model-form/use-open-router-search";
import {
  useDiscoverModels,
  useModelProviderCredentials,
  useProvidersRegistry,
  useRefreshCredentialModels,
  type DiscoveredModel,
  type DiscoveredModelsResponse,
  type ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import { OAuthPairingBody } from "./oauth-pairing-body";
import { usePairingDismissConfirm } from "../hooks/use-pairing-dismiss-confirm";
import {
  buildProviderPickerRows,
  CUSTOM_ENDPOINT_ID,
  CUSTOM_ID,
  getProviderById,
  resolveModelEntryId,
  resolveProviderId,
} from "@/lib/provider-registry-helpers";
import {
  buildModelFormPayload,
  type ModelFormFields,
  type ModelFormSubmit,
} from "@/lib/model-form-payload";
import { buildDiscoveredModelsPayload } from "@/lib/discovered-model-fields";
import { selectableCredentials } from "@/lib/model-credential-filter";
import { DiscoveredModelList } from "./model-form/discovered-model-list";
import { getProviderIcon } from "./icons";

/** This-session discovery, flattened: a failed request is one more outcome. */
interface DiscoveryState {
  /** Identifies the endpoint+key the listing came from — see `discoveryKey`. */
  key: string;
  outcome: DiscoveredModelsResponse["outcome"] | "request_failed";
  models: DiscoveredModel[];
}

/** The line under the discovery button when no listing came back. */
function discoveryErrorText(discovery: DiscoveryState, t: (key: string) => string): string {
  switch (discovery.outcome) {
    case "auth_failed":
      return t("models.form.discoverAuthFailed");
    case "blocked_url":
      return t("models.form.discoverBlockedUrl");
    case "request_failed":
      return t("models.form.discoverRequestFailed");
    case "rate_limited":
      return t("models.form.discoverRateLimited");
    case "unreachable":
      return t("models.form.discoverUnreachable");
    case "http_error":
      return t("models.form.discoverHttpError");
    case "bad_response":
      return t("models.form.discoverBadResponse");
    default:
      return t("models.form.discoverFailed");
  }
}

function parsesAsUrl(value: string): boolean {
  try {
    new URL(value.trim());
    return true;
  } catch {
    return false;
  }
}

interface ModelFormModalProps {
  open: boolean;
  onClose: () => void;
  model: OrgModelInfo | null;
  isPending: boolean;
  onSubmit: ModelFormSubmit;
}

/** What the combobox reads off a row, whatever the listing it came from. */
interface ComboboxModel {
  id: string;
  name: string;
  contextWindow: number | null;
}

/**
 * Searchable model picker over any listing the form can offer. Filtering is
 * the host's job — `shouldFilter={false}` — so a remote search and a
 * client-side one plug in the same way.
 */
function ModelCombobox<T extends ComboboxModel>({
  value,
  search,
  onSearchChange,
  models,
  isLoading,
  placeholder,
  emptyText,
  searchingText,
  onSelect,
}: {
  value: string;
  search: string;
  onSearchChange: (v: string) => void;
  models: T[];
  isLoading: boolean;
  placeholder: string;
  emptyText: string;
  searchingText: string;
  onSelect: (m: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [triggerWidth, setTriggerWidth] = useState<number | undefined>();
  const selected = models.find((m) => m.id === value);

  useEffect(() => {
    if (open && triggerRef.current) {
      setTriggerWidth(triggerRef.current.offsetWidth);
    }
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          {selected ? (
            <span className="truncate">{selected.name}</span>
          ) : value ? (
            <span className="truncate">{value}</span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        align="start"
        style={triggerWidth ? { width: triggerWidth } : undefined}
      >
        <Command shouldFilter={false}>
          <CommandInput placeholder={placeholder} value={search} onValueChange={onSearchChange} />
          <CommandList>
            {isLoading && (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                <Spinner className="size-3" />
                {searchingText}
              </div>
            )}
            {!isLoading && models.length === 0 && <CommandEmpty>{emptyText}</CommandEmpty>}
            {models.length > 0 && (
              <CommandGroup>
                {models.map((m) => (
                  <CommandItem
                    key={m.id}
                    value={m.id}
                    onSelect={() => {
                      onSelect(m);
                      onSearchChange(m.name);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn("mr-2 h-4 w-4", value === m.id ? "opacity-100" : "opacity-0")}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{m.name}</div>
                      <div className="text-muted-foreground truncate text-xs">{m.id}</div>
                    </div>
                    {m.contextWindow && (
                      <span className="text-muted-foreground ml-2 shrink-0 text-xs">
                        {Math.round(m.contextWindow / 1000)}k
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The form itself, without the dialog chrome — `ModelFormModal` owns the
 * `<Modal>`, its title and its footer buttons (which submit through
 * `form="model-form"`). Exported so the rendered form can be asserted on: a
 * Radix dialog renders nothing at all without a DOM.
 */
export function ModelFormBody({
  model,
  onSubmit,
  onMultiSelectionChange,
}: {
  model: OrgModelInfo | null;
  onSubmit: ModelFormSubmit;
  /** How many models the detected list has checked; `null` = single model. */
  onMultiSelectionChange?: (count: number | null) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  const registryQuery = useProvidersRegistry();
  // Every registry entry is a picker entry, except that the ones an operator
  // can point at their own endpoint collapse into a single "custom endpoint"
  // row: which of them it is becomes the "API type" question inside that
  // arrangement. The provider the form names is always a registry one — its
  // credential carries the apiShape and base URL the model will run on.
  //
  // The picker is split into two visual sections — "Featured" (the
  // module-declared canonical providers operators usually want) and
  // "Other" (everything else). The flag is metadata only; no write path
  // gates on it, so any entry remains selectable from either group.
  const registry = useMemo(() => registryQuery.data ?? [], [registryQuery.data]);

  // User-driven provider/model overrides — `null` means "follow auto-detect".
  const [providerOverride, setProviderOverride] = useState<string | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  /**
   * Rates imported from the OpenRouter live search — the only cost the form
   * submits. OpenRouter has no vendored catalog entry, so `resolveCatalogDefaults`
   * cannot resolve these on read and they must be persisted as an explicit
   * `org_models.cost` override. Every other path (catalog preset, editing an
   * existing row) leaves this `null`, which keeps the server resolving from the
   * catalog so weekly refreshes still propagate.
   */
  const [importedCost, setImportedCost] = useState<ModelCost | null>(null);

  // Prefer the persisted `providerId` — it distinguishes subscription
  // providers (claude-code, codex) that share an `apiShape` with their
  // API-key sibling (anthropic, openai). `resolveProviderId` heuristically
  // matches on apiShape+modelId and returns the first registry hit (the base
  // provider), so it would mis-select "Anthropic" for a "Claude Code" model.
  // Fall back to the heuristic only when the binding is hidden (aliases).
  const providerId =
    providerOverride ?? model?.providerId ?? (model ? resolveProviderId(model, registry) : "");
  const selectedModelId = modelOverride ?? resolveModelEntryId(model, registry);
  const setProviderId = (id: string) => setProviderOverride(id);
  const setSelectedModelId = (id: string) => setModelOverride(id);

  /**
   * Does the saved row carry limits or modalities of its own? `GET /api/models`
   * returns RESOLVED values, so a catalog-known id reports the catalog's — the
   * toggle then opens on values that are already true of the model, and saving
   * them again writes them as overrides. Harmless: the row keeps describing the
   * same model, it only stops following the weekly catalog refresh.
   */
  const hasStoredCapabilities =
    !!model &&
    (!!model.input?.length || !!model.contextWindow || !!model.maxTokens || !!model.reasoning);

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
      capabilitiesExplicit: hasStoredCapabilities,
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
    modelId,
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
      "modelId",
      "credentialId",
      "inlineApiKey",
      "capabilitiesExplicit",
      "inputText",
      "inputImage",
      "reasoning",
    ],
  });

  const credentialsQuery = useModelProviderCredentials();

  // `authMode` for the picked provider drives the credential UX:
  //   - "oauth2"  → no inline apiKey, must select an existing connection or
  //                 launch the OAuth dialog to create one.
  //   - "api_key" → inline apiKey input OR pick an existing matching credential.
  // The registry is the single source of truth — adding a provider on the
  // server flows through here without any client edits.
  const selectedProvider = useMemo(
    () => getProviderById(providerId, registry),
    [registry, providerId],
  );
  const isOauthProvider = selectedProvider?.authMode === "oauth2";

  // Which saved keys the picked provider can bind to — the whole rule lives in
  // `lib/model-credential-filter.ts`.
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

  // OAuth connect dialog — the pairing endpoint now returns the new
  // credentialId directly via `onConnected`, so we auto-select it in the
  // form without diffing the credential list.
  const [oauthDialogOpen, setOauthDialogOpen] = useState(false);
  const oauthDismiss = usePairingDismissConfirm(() => setOauthDialogOpen(false));

  // Synchronous model discovery. The model dropdown for OAuth providers is
  // sourced from THIS credential's served ids, so the endpoint is called
  // before the user can pick a model. What the endpoint DOES depends on the
  // provider's discovery mode: `mode: "static"` (both current subscription
  // providers) derives the list server-side from the provider definition ∩
  // catalog with zero requests; any other mode reads the provider's `GET
  // /models` listing once and intersects it with the candidates. Same
  // response shape either way — one code path here.
  const refreshModels = useRefreshCredentialModels();
  // This-session result, per credential: the ids the call just reported. It —
  // NOT the credential row's `available_model_ids` — drives the dropdown, so a
  // stale plan is never shown (and for a static provider the row is
  // deliberately empty). Null until the call returns (detector spinner shows);
  // empty array = answered, nothing served.
  const [servedModels, setServedModels] = useState<{ id: string; modelIds: string[] } | null>(null);
  // Credentials already refreshed THIS form-open (the body remounts per open,
  // so this resets each time the modal is reopened → a fresh listing every
  // config session). Prevents re-firing on reselect within one open.
  const refreshAttempted = React.useRef<Set<string>>(new Set());

  const refreshCredentialModels = (id: string) => {
    if (refreshAttempted.current.has(id)) return;
    refreshAttempted.current.add(id);
    // The dropdown reads the ids straight off the mutation response below, so
    // nothing cached needs invalidating either way — and for a static provider
    // there is nothing to invalidate at all: the call writes nothing, the seed
    // gate re-derives the same list from the definition ∩ catalog on its own.
    refreshModels.mutate(
      { params: { path: { id } } },
      {
        onSuccess: (data) => setServedModels({ id, modelIds: data.available_model_ids ?? [] }),
        onError: () => setServedModels({ id, modelIds: [] }),
      },
    );
  };

  const handleOpenOauthDialog = () => {
    setOauthDialogOpen(true);
  };

  const handleOauthConnected = (newId: string) => {
    setValue("credentialId", newId);
    setValue("inlineApiKey", "");
    clearErrors("credentialId");
    refreshCredentialModels(newId);
  };

  // "Select key → fetch the plan's models." Refetches on every selection
  // rather than reusing anything stored: a subscription's served models drift
  // over time while the credential doesn't, and a static provider's list is
  // derived per request from a catalog the weekly refresh moves.
  // `refreshAttempted` bounds it to one call per credential per form-open.
  useEffect(() => {
    if (!isOauthProvider || !credentialId || !selectedCredential) return;
    refreshCredentialModels(credentialId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOauthProvider, credentialId, selectedCredential]);

  const isOpenRouter = providerId === "openrouter";
  const openRouterSearch = useOpenRouterSearch(isOpenRouter);
  // A provider that lets the operator point the credential at their own
  // endpoint has no catalog behind it: base URL, model id, label and
  // capabilities are all typed in. Read off the registry flag, so a second
  // such provider needs no client edit.
  const isCustomProvider = selectedProvider?.baseUrlOverridable === true;
  // A custom endpoint types its model id too, but through the endpoint
  // arrangement below rather than the catalogued provider's escape hatch.
  const isCustomModel = !isCustomProvider && selectedModelId === CUSTOM_ID;
  const isPreset = !isCustomProvider && !isCustomModel && !!selectedModelId;
  const isCustom = isCustomProvider || isCustomModel;
  /**
   * What the capabilities section answered. `auto` and `hidden` differ on an
   * edit: a preset row never showed the section, so there is nothing of the
   * operator's to clear, while a custom one showed it and was left off — which
   * means "drop whatever was stored". An OpenRouter pick renders no section but
   * flags itself explicit, so its imported values still ship.
   */
  const capabilities = capabilitiesExplicit ? "explicit" : isCustom ? "auto" : "hidden";
  /** Registry entries that let the operator point at their own endpoint. */
  const overridableProviders = useMemo(
    () => registry.filter((p) => p.baseUrlOverridable),
    [registry],
  );
  const providerRows = useMemo(() => buildProviderPickerRows(registry), [registry]);

  // "Ask the endpoint what it serves." Persists nothing, so the listing lives
  // here for this form-open — and only for what it was run against, which
  // `discoveryKey` pins: editing the URL, the key or the provider makes it
  // stale rather than offering ids from an endpoint the form left behind.
  const discoverModels = useDiscoverModels();
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);
  const discoveryKey = [providerId, baseUrl.trim(), credentialId, inlineApiKey.trim()].join("|");
  const freshDiscovery = discovery?.key === discoveryKey ? discovery : null;
  const discoveredModels = freshDiscovery?.outcome === "ok" ? freshDiscovery.models : [];

  // Which detected models are checked. `null` — the form adds ONE model, the
  // one its fields name; an array — it adds exactly these, in one submit.
  const [selectedModelIds, setSelectedModelIds] = useState<string[] | null>(null);
  /** Ids a batch could not create — re-offered instead of silently dropped. */
  const [failedModelIds, setFailedModelIds] = useState<string[]>([]);
  /**
   * The credential a partially failed batch already created: a retry binds to
   * it rather than posting the same inline key a second time.
   */
  const [createdCredentialId, setCreatedCredentialId] = useState<string | null>(null);

  const applySelection = (ids: string[] | null) => {
    setSelectedModelIds(ids);
    onMultiSelectionChange?.(ids?.length ?? null);
  };
  /** A listing belongs to the endpoint it ran against, and to nothing else. */
  const dropDiscovery = () => {
    applySelection(null);
    setFailedModelIds([]);
    setCreatedCredentialId(null);
  };

  /** Step 1 answered: an endpoint that parses, and something to authenticate with. */
  const endpointReady =
    !!selectedProvider && parsesAsUrl(baseUrl) && (!!selectedCredential || !!inlineApiKey.trim());

  // How the model gets named, once the endpoint is known: ask it, or type it.
  // Keyed on the same endpoint as the listing, so editing step 1 puts step 2
  // back to its two buttons instead of describing an endpoint left behind.
  // An existing row already names a model, so it opens on the typed fields.
  const [modelModeState, setModelModeState] = useState<{
    key: string;
    mode: "detect" | "manual";
  } | null>(null);
  const modelMode =
    modelModeState?.key === discoveryKey ? modelModeState.mode : model ? "manual" : null;

  const switchModelMode = (next: "detect" | "manual") => {
    if (modelMode !== next) resetModelFields();
    setModelModeState({ key: discoveryKey, mode: next });
  };

  // Capabilities are the rare edit — folded away unless the row already
  // carries one, which is the same condition the toggle inside opens on.
  const [advancedOpen, setAdvancedOpen] = useState(() => hasStoredCapabilities);

  const handleDiscover = () => {
    if (!selectedProvider) return;
    const key = discoveryKey;
    dropDiscovery();
    discoverModels.mutate(
      {
        body: selectedCredential
          ? { credential_id: selectedCredential.id }
          : {
              provider_id: selectedProvider.providerId,
              api_key: inlineApiKey.trim(),
              ...(selectedProvider.baseUrlOverridable ? { base_url_override: baseUrl.trim() } : {}),
            },
      },
      {
        onSuccess: (data) => {
          setDiscovery({ key, outcome: data.outcome, models: data.models });
          // Nothing checked yet: the footer counts what the operator picks.
          if (data.outcome === "ok" && data.models.length > 0) applySelection([]);
        },
        onError: () => setDiscovery({ key, outcome: "request_failed", models: [] }),
      },
    );
  };

  const handleDetect = () => {
    switchModelMode("detect");
    handleDiscover();
  };

  // Models offered in the dropdown. For OAuth (subscription) providers the
  // list is EXACTLY what discovery reported for the selected credential —
  // derived server-side for a static provider, read off the endpoint's listing
  // otherwise — with no static "featured" floor. Empty until the call returns,
  // which is why the dropdown stays hidden until then. API-key providers keep
  // the full registry list (static catalog, no discovery).
  const modelOptions = useMemo(() => {
    if (!selectedProvider) return [];
    if (!isOauthProvider) return selectedProvider.models;
    // Only THIS session's fresh listing (matching the selected credential)
    // drives the list — the persisted `available_model_ids` is never used
    // for display, so a drifted plan can't leak stale models. Map each
    // served id to its catalog metadata; a served id absent from the
    // catalog (modelDiscoveryCandidates may list non-catalog ids) falls back
    // to an id-only entry so it stays selectable instead of vanishing —
    // otherwise an all-non-catalog plan would hang the detector spinner.
    const servedIds = servedModels?.id === credentialId ? servedModels.modelIds : [];
    const byId = new Map(selectedProvider.models.map((m) => [m.id, m]));
    return servedIds.map((id) => byId.get(id) ?? { id, label: id, featured: false });
  }, [selectedProvider, isOauthProvider, servedModels, credentialId]);

  const resetModelFields = () => {
    setValue("label", "");
    setValue("modelId", "");
    setValue("capabilitiesExplicit", false);
    setValue("inputText", true);
    setValue("inputImage", false);
    setValue("contextWindow", "");
    setValue("maxTokens", "");
    setValue("reasoning", false);
    setImportedCost(null);
    dropDiscovery();
  };

  const handleProviderChange = (id: string) => {
    setProviderId(id);
    clearErrors();

    setSelectedModelId("");
    // The credential belongs to the provider it was picked for — carrying it
    // over would bind the model to the endpoint the operator just left.
    setValue("credentialId", "");
    setValue("inlineApiKey", "");
    const provider = getProviderById(id, registry);
    if (provider) {
      setValue("apiShape", provider.apiShape);
      // Pre-seeded even when overridable: the operator edits the value they
      // are customising rather than typing a whole URL from scratch.
      setValue("baseUrl", provider.defaultBaseUrl);
    }
    resetModelFields();
    openRouterSearch.setSearch("");
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
    resetModelFields();
  };

  const handleModelChange = (id: string) => {
    setSelectedModelId(id);
    clearErrors();

    if (id === CUSTOM_ID) {
      resetModelFields();
      return;
    }

    const preset = selectedProvider?.models.find((m) => m.id === id);
    if (!preset) return;

    const caps = preset.capabilities;
    // Seeded so the fields describe the pick, but not as the operator's own
    // answer: a preset's capabilities belong to the catalog, which keeps
    // resolving (and refreshing) them server-side.
    setValue("capabilitiesExplicit", false);
    setValue("label", preset.label ?? preset.id);
    setValue("modelId", preset.id);
    setValue("inputText", caps.includes("text"));
    setValue("inputImage", caps.includes("image"));
    setValue("contextWindow", preset.contextWindow.toString());
    setValue("maxTokens", (preset.maxTokens ?? 0).toString());
    setValue("reasoning", caps.includes("reasoning"));
    // Not a repair — the only non-null writer (OpenRouter combobox) never renders with this Select.
    setImportedCost(null);
  };

  const onFormSubmit = handleSubmit(async (data) => {
    if (selectedModelIds !== null) {
      const batch = buildDiscoveredModelsPayload({
        models: discoveredModels.filter((m) => selectedModelIds.includes(m.id)),
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
      applySelection(outcome.failedModelIds);
      return;
    }
    const result = buildModelFormPayload({
      fields: data,
      dirtyFields,
      provider: selectedProvider,
      selectedCredentialId: selectedCredential?.id ?? null,
      importedCost,
      capabilities,
      isEdit: !!model,
    });
    if (!result.ok) {
      setError(result.field, { message: t(result.messageKey) });
      return;
    }
    onSubmit(result.data);
  });

  // Model dropdown. OAuth (subscription) providers show a FLAT list of the
  // models the listing reported — every entry is equally "available on the plan",
  // so the Featured/All split (and the Custom escape hatch, which would fail
  // the server's verified-only seed gate) is meaningless. Catalog-covered
  // API-key providers keep the split (50-100+ models) + Custom.
  const modelSelectJsx =
    selectedProvider && !isOpenRouter && modelOptions.length > 0 ? (
      <div className="space-y-2">
        <Label htmlFor="mdl-model">{t("models.form.modelId")}</Label>
        <Select value={selectedModelId} onValueChange={handleModelChange}>
          <SelectTrigger id="mdl-model">
            <SelectValue placeholder={t("models.form.modelPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {isOauthProvider ? (
              modelOptions.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label ?? m.id}
                </SelectItem>
              ))
            ) : (
              <>
                <ProviderPickerGroups
                  items={modelOptions}
                  featuredLabel={t("models.form.modelGroupFeatured")}
                  otherLabel={t("models.form.modelGroupAll")}
                  renderItem={(m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label ?? m.id}
                    </SelectItem>
                  )}
                />
                <SelectItem value={CUSTOM_ID}>{t("models.form.custom")}</SelectItem>
              </>
            )}
          </SelectContent>
        </Select>
      </div>
    ) : null;

  // The "or pick one you already saved" half of every api-key control here.
  const existingKeys = {
    items: availableCredentials,
    selected: selectedCredential ?? null,
    onSelect: (id: string) => {
      setValue("credentialId", id);
      setValue("inlineApiKey", "");
      // The key carries the endpoint it was saved against — the form follows it
      // there (and pins the field) instead of asking for the URL again.
      const picked = availableCredentials.find((k) => k.id === id);
      if (picked?.baseUrl) setValue("baseUrl", picked.baseUrl);
      dropDiscovery();
    },
    onClear: () => {
      setValue("credentialId", "");
      setValue("inlineApiKey", "");
      dropDiscovery();
    },
  };

  // Credential block — placement differs by authMode (see the form body):
  // OAuth surfaces it BEFORE the model select (connection drives the plan-
  // scoped model list); API-key surfaces it after a model is chosen.
  // Two flavors keyed on authMode: OAuth = pick/connect (no inline secret);
  // API key = type a new key inline OR pick an existing credential.
  const credentialBlockJsx = (
    <div className="space-y-2">
      <Label>
        {isOauthProvider ? t("models.form.connectionLabel") : t("credentials.form.apiKey")}
      </Label>

      {selectedCredential ? (
        <CredentialChip
          label={selectedCredential.label}
          icon={
            isOauthProvider ? (
              <Plug className="text-muted-foreground size-3.5 shrink-0" />
            ) : undefined
          }
          secondary={isOauthProvider ? selectedCredential.oauth_email : undefined}
          onClear={existingKeys.onClear}
        />
      ) : isOauthProvider ? (
        // OAuth: existing-connection select stacks ABOVE the connect
        // button when there's at least one match — single column avoids
        // the side-by-side overflow when the provider name is long.
        <div className="flex flex-col gap-2">
          {availableCredentials.length > 0 && (
            <Select
              value=""
              onValueChange={(id) => {
                setValue("credentialId", id);
                setValue("inlineApiKey", "");
                clearErrors("credentialId");
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("models.form.useExistingConnection")} />
              </SelectTrigger>
              <SelectContent>
                {availableCredentials.map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    <span className="flex items-center gap-2">
                      <span className="truncate">{k.label}</span>
                      {k.oauth_email && (
                        <span className="text-muted-foreground truncate text-xs">
                          {k.oauth_email}
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            type="button"
            variant="outline"
            className={cn(
              "w-full min-w-0 justify-start",
              showError("credentialId") && "border-destructive",
            )}
            onClick={handleOpenOauthDialog}
          >
            <Plug className="mr-2 size-4 shrink-0" />
            <span className="truncate">
              {availableCredentials.length > 0
                ? t("models.form.connectAnother", {
                    provider: selectedProvider?.displayName ?? providerId,
                  })
                : t("models.form.connectProvider", {
                    provider: selectedProvider?.displayName ?? providerId,
                  })}
            </span>
          </Button>
        </div>
      ) : (
        <ApiKeyRow
          id="mdl-apiKey"
          apiKeyProps={register("inlineApiKey")}
          invalid={showError("credentialId")}
          existingKeys={existingKeys}
        />
      )}

      {!selectedCredential && !isOauthProvider && inlineApiKey.trim() && (
        <div className="text-muted-foreground text-sm">{t("models.form.createCredentialHint")}</div>
      )}
      {!selectedCredential && isOauthProvider && (
        <div className="text-muted-foreground text-sm">{t("models.form.connectProviderHint")}</div>
      )}
      {showError("credentialId") && errors.credentialId?.message && (
        <div className="text-destructive text-sm">{errors.credentialId.message}</div>
      )}
    </div>
  );

  /**
   * Step 2 answered: the model is being picked from what the endpoint serves,
   * or typed in. Until then the two buttons are all there is.
   */
  const showModelFields =
    modelMode === "manual" || (modelMode === "detect" && discoveredModels.length > 0);
  /** The typed model id reaches the screen only once both steps are answered. */
  const modelIdOnScreen = endpointReady && showModelFields;

  // A preset carries its own values; anywhere else they are typed or picked.
  const baseUrlValidate = (v: string) =>
    isPreset || parsesAsUrl(v) ? undefined : t("validation.required", { ns: "common" });
  // A custom endpoint has to get through both steps before there is an id to
  // require, so an empty one names the steps rather than the field.
  const modelIdValidate = (v: string) =>
    isPreset || v.trim()
      ? undefined
      : isCustomProvider && !modelIdOnScreen
        ? t("models.form.modelStepRequired")
        : t("validation.required", { ns: "common" });

  // The typed fields, built where they render so RHF validates each under the
  // arrangement that puts it on screen.
  // Creating, an empty name lets the server derive one. Editing, PATCH reads an
  // absent name as "keep it", so clearing it is refused rather than saved.
  const labelValidate = (v: string) =>
    !model || v.trim() ? undefined : t("validation.required", { ns: "common" });

  const labelFieldJsx = isCustom ? (
    <div className="space-y-2">
      <Label htmlFor="mdl-label">{t("models.form.label")}</Label>
      <Input
        id="mdl-label"
        type="text"
        {...register("label", { validate: labelValidate })}
        placeholder={model ? undefined : t("models.form.labelPlaceholder")}
        aria-invalid={showError("label") ? true : undefined}
        className={cn(showError("label") && "border-destructive")}
      />
      {showError("label") && errors.label?.message && (
        <div className="text-destructive text-sm">{errors.label.message}</div>
      )}
    </div>
  ) : null;

  const baseUrlFieldJsx = isCustomModel ? (
    <BaseUrlField
      id="mdl-baseUrl"
      baseUrlProps={register("baseUrl", { validate: baseUrlValidate })}
      // The URL is a property of the credential (`baseUrlOverride`), not of the
      // model, so it only moves when a credential is created with it.
      locked={!!selectedCredential}
      error={showError("baseUrl") ? errors.baseUrl?.message : undefined}
      placeholder={selectedProvider?.defaultBaseUrl}
    />
  ) : null;

  const modelIdErrorJsx =
    showError("modelId") && errors.modelId?.message ? (
      <div className="text-destructive text-sm">{errors.modelId.message}</div>
    ) : null;

  const renderModelIdInput = () => (
    <div className="space-y-2">
      <Label htmlFor="mdl-modelId">{t("models.form.modelId")}</Label>
      <Input
        id="mdl-modelId"
        type="text"
        {...register("modelId", { validate: modelIdValidate })}
        placeholder="ex: claude-sonnet-4-5-20250929"
        aria-invalid={showError("modelId") ? true : undefined}
        className={cn(showError("modelId") && "border-destructive")}
      />
      {modelIdErrorJsx}
    </div>
  );

  // Capabilities — custom provider/model only; preset and OpenRouter auto-fill
  // them from their source of truth.
  const capabilitiesJsx = isCustom ? (
    <CapabilitiesSection
      explicit={capabilitiesExplicit}
      contextWindowProps={register("contextWindow")}
      maxTokensProps={register("maxTokens")}
      inputText={inputText}
      inputImage={inputImage}
      reasoning={reasoning}
      onExplicitChange={(v) => setValue("capabilitiesExplicit", v)}
      onInputTextChange={(v) => setValue("inputText", v)}
      onInputImageChange={(v) => setValue("inputImage", v)}
      onReasoningChange={(v) => setValue("reasoning", v)}
    />
  ) : null;

  // Step 2 — the model, once the endpoint is reachable. Ask it what it serves
  // or type the id in; nothing below the two buttons until one is chosen.
  // Built only for an endpoint that has one, so RHF registers `modelId` under
  // exactly the arrangement that puts it on screen.
  const modelStepJsx = isCustomProvider ? (
    <>
      <div className="space-y-2">
        {/* Detection adds rows; an edit changes one. So the choice only exists
            on create, and an edit is always the typed-in arrangement. */}
        {!model && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={modelMode === "detect" ? "default" : "outline"}
              onClick={handleDetect}
              disabled={discoverModels.isPending}
            >
              {discoverModels.isPending ? <Spinner /> : t("models.form.discoverButton")}
            </Button>
            <Button
              type="button"
              variant={modelMode === "manual" ? "default" : "outline"}
              onClick={() => switchModelMode("manual")}
            >
              {t("models.form.manualButton")}
            </Button>
          </div>
        )}
        {modelMode === "detect" &&
          freshDiscovery &&
          (freshDiscovery.outcome === "ok" ? (
            <div className="text-muted-foreground text-sm">
              {freshDiscovery.models.length > 0
                ? t("models.form.discoverCount", { count: freshDiscovery.models.length })
                : t("models.form.discoverEmpty")}
            </div>
          ) : (
            <div className="text-destructive text-sm">{discoveryErrorText(freshDiscovery, t)}</div>
          ))}
      </div>

      {showModelFields &&
        (modelMode === "detect" ? (
          <div className="space-y-2">
            <Label>{t("models.form.modelId")}</Label>
            {/* Names and capabilities come from the listing itself, and the
                models table edits them afterwards: the batch asks which ones. */}
            <DiscoveredModelList
              models={discoveredModels}
              selectedIds={selectedModelIds ?? []}
              onSelectionChange={applySelection}
            />
            {modelIdErrorJsx}
            {failedModelIds.length > 0 && (
              <div className="text-destructive text-sm">
                {t("models.form.addFailed", { ids: failedModelIds.join(", ") })}
              </div>
            )}
          </div>
        ) : (
          <>
            {renderModelIdInput()}
            {labelFieldJsx}
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="text-foreground hover:bg-muted/50 border-border flex w-full items-center justify-between rounded-md border border-dashed px-3 py-2 text-sm font-medium transition-colors"
                >
                  <span>{t("models.form.advanced")}</span>
                  <ChevronDown
                    className={cn(
                      "text-muted-foreground size-4 transition-transform",
                      advancedOpen && "rotate-180",
                    )}
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>{capabilitiesJsx}</CollapsibleContent>
            </Collapsible>
          </>
        ))}
    </>
  ) : null;

  return (
    <form id="model-form" onSubmit={onFormSubmit} className="space-y-4">
      {/* Provider select */}
      <div className="space-y-2">
        <Label htmlFor="mdl-provider">{t("models.form.provider")}</Label>
        <Select
          value={isCustomProvider ? CUSTOM_ENDPOINT_ID : providerId}
          onValueChange={(id) =>
            handleProviderChange(
              id === CUSTOM_ENDPOINT_ID ? (overridableProviders[0]?.providerId ?? "") : id,
            )
          }
        >
          <SelectTrigger id="mdl-provider">
            <SelectValue placeholder={t("models.form.providerPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <ProviderPickerGroups
              items={providerRows}
              featuredLabel={t("models.form.providerGroupFeatured")}
              otherLabel={t("models.form.providerGroupOther")}
              renderItem={(row) => {
                // Every endpoint the operator can point somewhere else is one
                // picker entry; which of them it is becomes the "API type"
                // question inside the arrangement below.
                if (row.kind === "customEndpoint") {
                  return (
                    <SelectItem key={CUSTOM_ENDPOINT_ID} value={CUSTOM_ENDPOINT_ID}>
                      <span className="flex items-center gap-2">
                        <Server className="size-4" />
                        {t("models.form.customEndpoint")}
                      </span>
                    </SelectItem>
                  );
                }
                const Icon = getProviderIcon(row.entry);
                return (
                  <SelectItem key={row.entry.providerId} value={row.entry.providerId}>
                    <span className="flex items-center gap-2">
                      {Icon && <Icon className="size-4" />}
                      {row.entry.displayName}
                    </span>
                  </SelectItem>
                );
              }}
            />
          </SelectContent>
        </Select>
      </div>

      {isCustomProvider ? (
        /* An operator-supplied endpoint answers for itself: describe and open
           it (step 1), then ask it — or tell it — which model to run (step 2). */
        <>
          <EndpointFields
            idPrefix="mdl"
            providers={overridableProviders}
            providerId={providerId}
            onApiTypeChange={handleApiTypeChange}
            // The endpoint belongs to the saved row; changing it would rebind
            // the model to a service it was never verified against.
            providerLocked={!!model}
            baseUrlProps={register("baseUrl", {
              validate: baseUrlValidate,
              onChange: dropDiscovery,
            })}
            baseUrlLocked={!!selectedCredential}
            baseUrlError={showError("baseUrl") ? errors.baseUrl?.message : undefined}
            apiKeyProps={register("inlineApiKey", { onChange: dropDiscovery })}
            apiKeyError={showError("credentialId") ? errors.credentialId?.message : undefined}
            apiKeyHint={
              !selectedCredential && inlineApiKey.trim()
                ? t("models.form.createCredentialHint")
                : undefined
            }
            existingKeys={existingKeys}
          />
          {endpointReady && modelStepJsx}
          {/* Registered even where neither step put it on screen — an id nothing
              validates turns saving too early into a dead button. */}
          {!modelIdOnScreen && (
            <>
              <input type="hidden" {...register("modelId", { validate: modelIdValidate })} />
              {modelIdErrorJsx}
            </>
          )}
        </>
      ) : (
        <>
          {/* OAuth (subscription) providers need the connection FIRST: the
              served model list depends on the account's plan, known only by
              asking the live credential. So the order flips to connection →
              listing → model. API-key / OpenRouter providers keep model-first
              (static catalog, no per-credential discovery). */}
          {isOauthProvider ? (
            <>
              {credentialBlockJsx}
              {/* Model dropdown is gated on the listing: it appears only once
                  refresh-models has returned the plan's served ids (metadata
                  comes from the already-loaded registry catalog). A listing
                  that found nothing shows the empty-state instead of an empty
                  dropdown. */}
              {selectedCredential &&
                (() => {
                  const fresh = servedModels?.id === credentialId ? servedModels : null;
                  // No result yet → call in flight (or, rarely, the registry
                  // catalog is still loading) → detector spinner.
                  if (!fresh || (fresh.modelIds.length > 0 && modelOptions.length === 0)) {
                    return (
                      <div className="text-muted-foreground flex items-center gap-2 text-sm">
                        <Spinner /> {t("models.form.detectingModels")}
                      </div>
                    );
                  }
                  if (fresh.modelIds.length === 0) {
                    return (
                      <div className="text-muted-foreground text-sm">
                        {t("models.form.noModelsDetected")}
                      </div>
                    );
                  }
                  return modelSelectJsx;
                })()}
            </>
          ) : (
            modelSelectJsx
          )}

          {/* OpenRouter model search (combobox) */}
          {isOpenRouter && (
            <div className="space-y-2">
              <Label>{t("models.form.modelId")}</Label>
              <ModelCombobox
                value={modelId}
                search={openRouterSearch.search}
                onSearchChange={openRouterSearch.setSearch}
                models={openRouterSearch.models}
                isLoading={openRouterSearch.isLoading}
                placeholder={t("models.form.openRouterSearchPlaceholder")}
                emptyText={t("models.form.openRouterNoResults")}
                searchingText={t("models.form.openRouterSearching")}
                onSelect={(m) => {
                  // OpenRouter has no vendored catalog, so every field comes
                  // from the live API and must be persisted as an explicit
                  // override — including cost. The pick IS the explicit answer
                  // the capabilities toggle asks for elsewhere (no section is
                  // rendered here), and the name ships as a typed-in one.
                  setSelectedModelId(m.id);
                  setValue("modelId", m.id);
                  setValue("label", m.name, { shouldDirty: true });
                  setValue("capabilitiesExplicit", true);
                  if (m.contextWindow) setValue("contextWindow", m.contextWindow.toString());
                  if (m.maxTokens) setValue("maxTokens", m.maxTokens.toString());
                  setValue("inputText", m.input?.includes("text") !== false);
                  setValue("inputImage", m.input?.includes("image") ?? false);
                  setValue("reasoning", m.reasoning ?? false);
                  // `useOpenRouterModels` already narrows the wire cost to
                  // `ModelCost | null` in its `select`, so no re-normalisation here.
                  setImportedCost(m.cost);
                }}
              />
            </div>
          )}

          {labelFieldJsx}

          {/* API-key / OpenRouter credential block — surfaced AFTER a model
              is chosen. OAuth providers render their connection block above
              (before the model select), so they're excluded here. */}
          {!isOauthProvider &&
            (!!selectedModelId || (isOpenRouter && !!modelId)) &&
            credentialBlockJsx}

          {baseUrlFieldJsx}
          {isCustomModel && renderModelIdInput()}
          {capabilitiesJsx}
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
              handleOauthConnected(newId);
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
