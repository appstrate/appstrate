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
import { Check, ChevronsUpDown, KeyRound, Plug, X } from "lucide-react";
import { type OrgModelInfo } from "../hooks/use-models";
import type { ModelCost } from "@appstrate/core/module";
import { CapabilitiesSection } from "./model-form/capabilities-section";
import { useOpenRouterSearch } from "./model-form/use-open-router-search";
import {
  useDiscoverModels,
  useModelProviderCredentials,
  useProvidersRegistry,
  useRefreshCredentialModels,
  type DiscoveredModel,
  type DiscoveredModelsResponse,
} from "../hooks/use-model-provider-credentials";
import { OAuthPairingBody } from "./oauth-pairing-body";
import { usePairingDismissConfirm } from "../hooks/use-pairing-dismiss-confirm";
import {
  CUSTOM_ID,
  getProviderById,
  resolveModelEntryId,
  resolveProviderId,
} from "@/lib/provider-registry-helpers";
import {
  buildModelFormPayload,
  type ModelFormData,
  type ModelFormFields,
} from "@/lib/model-form-payload";
import { discoveredModelToFieldValues } from "@/lib/discovered-model-fields";
import { getProviderIcon } from "./icons";

/** This-session discovery, flattened: a failed request is one more outcome. */
interface DiscoveryState {
  /** Identifies the endpoint+key the listing came from — see `discoveryKey`. */
  key: string;
  outcome: DiscoveredModelsResponse["outcome"] | "request_failed";
  models: DiscoveredModel[];
  message: string | null;
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
    // unreachable | http_error | bad_response | rate_limited.
    default:
      return t("models.form.discoverFailed") + (discovery.message ? ` ${discovery.message}` : "");
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
  onSubmit: (data: ModelFormData) => void;
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
 * client-side one plug in the same way, and `freeTextItem` adds a row adopting
 * the raw typed text so an id the listing omits stays enterable.
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
  freeTextItem,
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
  freeTextItem?: { label: string; onSelect: () => void };
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
            {!isLoading && models.length === 0 && !freeTextItem && (
              <CommandEmpty>{emptyText}</CommandEmpty>
            )}
            {freeTextItem && (
              <CommandGroup>
                <CommandItem
                  value={freeTextItem.label}
                  onSelect={() => {
                    freeTextItem.onSelect();
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{freeTextItem.label}</span>
                </CommandItem>
              </CommandGroup>
            )}
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
}: {
  model: OrgModelInfo | null;
  onSubmit: (data: ModelFormData) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  const registryQuery = useProvidersRegistry();
  // Every registry entry is a picker entry, `openai-compatible` (the
  // free-form-baseUrl escape hatch, displayed "OpenAI-compatible (custom)")
  // included — its credential carries the apiShape and base URL the model
  // will run on, so it has to be the provider the form names.
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
      inputText: model?.input?.includes("text") !== false,
      inputImage: model?.input?.includes("image") ?? false,
      contextWindow: model?.contextWindow?.toString() ?? "",
      maxTokens: model?.maxTokens?.toString() ?? "",
      reasoning: model?.reasoning ?? false,
    },
  });

  const [apiShape, baseUrl, modelId, credentialId, inlineApiKey, inputText, inputImage, reasoning] =
    useWatch({
      control,
      name: [
        "apiShape",
        "baseUrl",
        "modelId",
        "credentialId",
        "inlineApiKey",
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
  const registryEntry = useMemo(
    () => registryQuery.data?.find((p) => p.providerId === providerId),
    [registryQuery.data, providerId],
  );
  const authMode: "api_key" | "oauth2" = registryEntry?.authMode ?? "api_key";
  const isOauthProvider = authMode === "oauth2";

  // Filter the existing credential list to those compatible with the picked
  // provider:
  //   - OAuth: pin to the canonical `providerId` (DB column) — apiShape +
  //            baseUrl would collide with api-key Anthropic credentials.
  //   - api-key: match on apiShape + baseUrl as before.
  //
  // Built-in (`source: "built-in"`) credentials come from `SYSTEM_PROVIDER_KEYS`
  // env and use a slug id (e.g. `"anthropic"`), not a UUID — `org_models.credential_id`
  // is a UUID FK to `model_provider_credentials.id` and would 400 the insert.
  // Operators add models against system keys by declaring them in the env
  // `models[]` block, not via this form. Hiding them removes the trap.
  const availableCredentials = useMemo(() => {
    if (!credentialsQuery.data) return [];
    const customOnly = credentialsQuery.data.filter((k) => k.source === "custom");
    if (isOauthProvider) {
      return customOnly.filter((k) => k.authMode === "oauth2" && k.providerId === providerId);
    }
    if (!apiShape || !baseUrl) return [];
    const normalizedBase = baseUrl.replace(/\/+$/, "");
    return customOnly.filter(
      (k) =>
        k.authMode === "api_key" &&
        k.apiShape === apiShape &&
        // `baseUrl` is null only for alias-only built-in credentials, which are
        // already excluded by the `customOnly` filter above — guard anyway so
        // the type narrows (binding-hidden credentials never match a form pick).
        k.baseUrl != null &&
        k.baseUrl.replace(/\/+$/, "") === normalizedBase,
    );
  }, [credentialsQuery.data, apiShape, baseUrl, isOauthProvider, providerId]);

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
  // catalog and probes nothing; a probe provider runs one 1-token inference
  // per candidate. Same response shape either way — one code path here.
  const refreshModels = useRefreshCredentialModels();
  // This-session result, per credential: the ids the call just reported. It —
  // NOT the credential row's `available_model_ids` — drives the dropdown, so a
  // stale plan is never shown (and for a static provider the row is
  // deliberately empty). Null until the call returns (detector spinner shows);
  // empty array = answered, nothing served.
  const [probeResult, setProbeResult] = useState<{ id: string; modelIds: string[] } | null>(null);
  // Credentials already probed THIS form-open (the body remounts per open,
  // so this resets each time the modal is reopened → a fresh probe every
  // config session). Prevents re-firing on reselect within one open.
  const probeAttempted = React.useRef<Set<string>>(new Set());

  const probeCredential = (id: string) => {
    if (probeAttempted.current.has(id)) return;
    probeAttempted.current.add(id);
    // The dropdown reads the ids straight off the mutation response below, so
    // nothing cached needs invalidating either way — and for a static provider
    // there is nothing to invalidate at all: the call writes nothing, the seed
    // gate re-derives the same list from the definition ∩ catalog on its own.
    refreshModels.mutate(
      { params: { path: { id } } },
      {
        onSuccess: (data) => setProbeResult({ id, modelIds: data.available_model_ids ?? [] }),
        onError: () => setProbeResult({ id, modelIds: [] }),
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
    probeCredential(newId);
  };

  // "Select key → fetch the plan's models." Refetches on every selection
  // rather than reusing anything stored: a subscription's served models drift
  // over time while the credential doesn't, and a static provider's list is
  // derived per request from a catalog the weekly refresh moves.
  // `probeAttempted` bounds it to one call per credential per form-open.
  useEffect(() => {
    if (!isOauthProvider || !credentialId || !selectedCredential) return;
    probeCredential(credentialId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOauthProvider, credentialId, selectedCredential]);

  const isOpenRouter = providerId === "openrouter";
  const openRouterSearch = useOpenRouterSearch(isOpenRouter);
  const selectedProvider = getProviderById(providerId, registry);
  // A provider that lets the operator point the credential at their own
  // endpoint has no catalog behind it: base URL, model id, label and
  // capabilities are all typed in. Read off the registry flag, so a second
  // such provider needs no client edit.
  const isCustomProvider = selectedProvider?.baseUrlOverridable === true;
  const isCustomModel = selectedModelId === CUSTOM_ID;
  const isPreset = !isCustomProvider && !isCustomModel && !!selectedModelId;
  const isCustom = isCustomProvider || isCustomModel;

  // "Ask the endpoint what it serves." Persists nothing, so the listing lives
  // here for this form-open — and only for what it was run against, which
  // `discoveryKey` pins: editing the URL, the key or the provider makes it
  // stale rather than offering ids from an endpoint the form left behind.
  const discoverModels = useDiscoverModels();
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);
  const [discoverySearch, setDiscoverySearch] = useState("");
  const discoveryKey = [providerId, baseUrl.trim(), credentialId, inlineApiKey.trim()].join("|");
  const freshDiscovery = discovery?.key === discoveryKey ? discovery : null;
  const discoveredModels = freshDiscovery?.outcome === "ok" ? freshDiscovery.models : [];

  const canDiscover =
    !!selectedProvider && parsesAsUrl(baseUrl) && (!!credentialId || !!inlineApiKey.trim());

  const handleDiscover = () => {
    if (!selectedProvider) return;
    const key = discoveryKey;
    setDiscoverySearch("");
    discoverModels.mutate(
      {
        body: credentialId
          ? { credential_id: credentialId }
          : {
              provider_id: selectedProvider.providerId,
              api_key: inlineApiKey.trim(),
              ...(selectedProvider.baseUrlOverridable ? { base_url_override: baseUrl.trim() } : {}),
            },
      },
      {
        onSuccess: (data) =>
          setDiscovery({ key, outcome: data.outcome, models: data.models, message: data.message }),
        onError: () => setDiscovery({ key, outcome: "request_failed", models: [], message: null }),
      },
    );
  };

  // Same reason as the OpenRouter import below: nothing resolves these on read
  // for such an endpoint, so each write is dirty and ships as an override.
  const applyDiscoveredModel = (m: DiscoveredModel) => {
    const next = discoveredModelToFieldValues(m);
    setValue("modelId", next.modelId, { shouldDirty: true });
    setValue("label", next.label, { shouldDirty: true });
    if (next.contextWindow !== undefined)
      setValue("contextWindow", next.contextWindow, { shouldDirty: true });
    if (next.maxTokens !== undefined) setValue("maxTokens", next.maxTokens, { shouldDirty: true });
    if (next.inputText !== undefined) setValue("inputText", next.inputText, { shouldDirty: true });
    if (next.inputImage !== undefined)
      setValue("inputImage", next.inputImage, { shouldDirty: true });
    if (next.reasoning !== undefined) setValue("reasoning", next.reasoning, { shouldDirty: true });
  };

  // Models offered in the dropdown. For OAuth (subscription) providers the
  // list is EXACTLY what discovery reported for the selected credential —
  // derived server-side for a static provider, probe-verified for a probe one
  // — with no static "featured" floor. Empty until the call returns, which is
  // why the dropdown stays hidden until then. API-key providers keep the full
  // registry list (static catalog, no discovery).
  const modelOptions = useMemo(() => {
    if (!selectedProvider) return [];
    if (!isOauthProvider) return selectedProvider.models;
    // Only THIS session's fresh probe (matching the selected credential)
    // drives the list — the persisted `available_model_ids` is never used
    // for display, so a drifted plan can't leak stale models. Map each
    // verified id to its catalog metadata; a verified id absent from the
    // catalog (modelDiscoveryCandidates may list non-catalog ids) falls back
    // to an id-only entry so it stays selectable instead of vanishing —
    // otherwise an all-non-catalog plan would hang the detector spinner.
    const verifiedIds = probeResult?.id === credentialId ? probeResult.modelIds : [];
    const byId = new Map(selectedProvider.models.map((m) => [m.id, m]));
    return verifiedIds.map((id) => byId.get(id) ?? { id, label: id, featured: false });
  }, [selectedProvider, isOauthProvider, probeResult, credentialId]);

  const resetModelFields = () => {
    setValue("label", "");
    setValue("modelId", "");
    setValue("inputText", true);
    setValue("inputImage", false);
    setValue("contextWindow", "");
    setValue("maxTokens", "");
    setValue("reasoning", false);
    setImportedCost(null);
  };

  const handleProviderChange = (id: string) => {
    setProviderId(id);
    clearErrors();

    setSelectedModelId("");
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

  const onFormSubmit = handleSubmit((data) => {
    const result = buildModelFormPayload({
      fields: data,
      dirtyFields,
      provider: selectedProvider,
      importedCost,
    });
    if (!result.ok) {
      setError(result.field, { message: t(result.messageKey) });
      return;
    }
    onSubmit(result.data);
  });

  // Model dropdown. OAuth (subscription) providers show a FLAT list of the
  // models discovery reported — every entry is equally "available on the plan",
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
        <div className="flex gap-2">
          <div className="border-input bg-muted flex h-9 flex-1 items-center gap-2 rounded-md border px-3 text-sm">
            {isOauthProvider ? (
              <Plug className="text-muted-foreground size-3.5 shrink-0" />
            ) : (
              <KeyRound className="text-muted-foreground size-3.5 shrink-0" />
            )}
            <span className="truncate">{selectedCredential.label}</span>
            {isOauthProvider && selectedCredential.oauth_email && (
              <span className="text-muted-foreground truncate text-xs">
                ({selectedCredential.oauth_email})
              </span>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => {
              setValue("credentialId", "");
              setValue("inlineApiKey", "");
            }}
          >
            <X className="size-4" />
            <span className="sr-only">{t("btn.cancel")}</span>
          </Button>
        </div>
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
                    provider: registryEntry?.displayName ?? providerId,
                  })
                : t("models.form.connectProvider", {
                    provider: registryEntry?.displayName ?? providerId,
                  })}
            </span>
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            type="password"
            {...register("inlineApiKey")}
            placeholder="sk-..."
            className={cn("min-w-0 flex-1", showError("credentialId") && "border-destructive")}
            aria-invalid={showError("credentialId") ? true : undefined}
          />
          {availableCredentials.length > 0 && (
            <Select
              value=""
              onValueChange={(id) => {
                setValue("credentialId", id);
                setValue("inlineApiKey", "");
              }}
            >
              <SelectTrigger className="w-32 shrink-0">
                <SelectValue placeholder={t("models.form.useExistingKey")} />
              </SelectTrigger>
              <SelectContent>
                {availableCredentials.map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
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

  // A preset fills the typed fields from its catalog entry; a custom entry has
  // to carry them, so blank is an error there and only there.
  const requiredUnlessPreset = (v: string) =>
    isPreset || v.trim() ? undefined : t("validation.required", { ns: "common" });

  // The four typed fields. Built only when they render, so RHF registers
  // (and validates) them under exactly the condition it did before.
  const labelFieldJsx = isCustom ? (
    <div className="space-y-2">
      <Label htmlFor="mdl-label">{t("models.form.label")}</Label>
      <Input
        id="mdl-label"
        type="text"
        {...register("label", { validate: requiredUnlessPreset })}
        placeholder="ex: Claude Sonnet"
        aria-invalid={showError("label") ? true : undefined}
        className={cn(showError("label") && "border-destructive")}
      />
      {showError("label") && errors.label?.message && (
        <div className="text-destructive text-sm">{errors.label.message}</div>
      )}
    </div>
  ) : null;

  const baseUrlFieldJsx = isCustom ? (
    <div className="space-y-2">
      <Label htmlFor="mdl-baseUrl">{t("models.form.baseUrl")}</Label>
      <Input
        id="mdl-baseUrl"
        type="url"
        {...register("baseUrl", {
          validate: (v) =>
            isPreset || parsesAsUrl(v) ? undefined : t("validation.required", { ns: "common" }),
        })}
        placeholder="https://api.openai.com/v1"
        aria-invalid={showError("baseUrl") ? true : undefined}
        className={cn(showError("baseUrl") && "border-destructive")}
      />
      <div className="text-muted-foreground text-sm">{t("models.form.baseUrlHint")}</div>
      {showError("baseUrl") && errors.baseUrl?.message && (
        <div className="text-destructive text-sm">{errors.baseUrl.message}</div>
      )}
    </div>
  ) : null;

  // Rows for the discovered-model combobox: filtered here (the picker itself
  // never filters) and named the way every listing names its rows.
  const typedModelId = discoverySearch.trim();
  const discoveryQuery = typedModelId.toLowerCase();
  const discoveredRows = discoveredModels
    .filter(
      (m) =>
        !discoveryQuery ||
        m.id.toLowerCase().includes(discoveryQuery) ||
        (m.label ?? "").toLowerCase().includes(discoveryQuery),
    )
    .map((m) => ({ ...m, name: m.label ?? m.id, contextWindow: m.context_window }));
  // Offered only for text that names nothing in the listing — picking a row
  // puts its label in the search box, which must not read as a new id.
  const freeTextItem =
    typedModelId &&
    !discoveredModels.some((m) => m.id === typedModelId || (m.label ?? m.id) === typedModelId)
      ? {
          label: t("models.form.discoverUseTyped", { id: typedModelId }),
          onSelect: () => setValue("modelId", typedModelId, { shouldDirty: true }),
        }
      : undefined;

  const modelIdErrorJsx =
    showError("modelId") && errors.modelId?.message ? (
      <div className="text-destructive text-sm">{errors.modelId.message}</div>
    ) : null;

  // Once an endpoint has answered, the id is picked from what it serves. The
  // hidden input keeps RHF validating the field the picker now writes.
  const modelIdFieldJsx = !isCustom ? null : discoveredModels.length > 0 ? (
    <div className="space-y-2">
      <Label>{t("models.form.modelId")}</Label>
      <ModelCombobox
        value={modelId}
        search={discoverySearch}
        onSearchChange={setDiscoverySearch}
        models={discoveredRows}
        isLoading={discoverModels.isPending}
        placeholder={t("models.form.discoverSearchPlaceholder")}
        emptyText={t("models.form.discoverNoMatch")}
        searchingText={t("models.form.discovering")}
        onSelect={applyDiscoveredModel}
        freeTextItem={freeTextItem}
      />
      <input type="hidden" {...register("modelId", { validate: requiredUnlessPreset })} />
      {modelIdErrorJsx}
    </div>
  ) : (
    <div className="space-y-2">
      <Label htmlFor="mdl-modelId">{t("models.form.modelId")}</Label>
      <Input
        id="mdl-modelId"
        type="text"
        {...register("modelId", { validate: requiredUnlessPreset })}
        placeholder="ex: claude-sonnet-4-5-20250929"
        aria-invalid={showError("modelId") ? true : undefined}
        className={cn(showError("modelId") && "border-destructive")}
      />
      {modelIdErrorJsx}
    </div>
  );

  // Custom (operator-supplied) endpoints only — a catalog already lists its models.
  const discoverJsx = isCustomProvider ? (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        onClick={handleDiscover}
        disabled={!canDiscover || discoverModels.isPending}
      >
        {discoverModels.isPending ? <Spinner /> : t("models.form.discoverButton")}
      </Button>
      {freshDiscovery &&
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
  ) : null;

  // Capabilities — custom provider/model only; preset and OpenRouter auto-fill
  // them from their source of truth.
  const capabilitiesJsx = isCustom ? (
    <CapabilitiesSection
      contextWindowProps={register("contextWindow")}
      maxTokensProps={register("maxTokens")}
      inputText={inputText}
      inputImage={inputImage}
      reasoning={reasoning}
      onInputTextChange={(v) => setValue("inputText", v)}
      onInputImageChange={(v) => setValue("inputImage", v)}
      onReasoningChange={(v) => setValue("reasoning", v)}
    />
  ) : null;

  return (
    <form id="model-form" onSubmit={onFormSubmit} className="space-y-4">
      {/* Provider select */}
      <div className="space-y-2">
        <Label htmlFor="mdl-provider">{t("models.form.provider")}</Label>
        <Select value={providerId} onValueChange={handleProviderChange}>
          <SelectTrigger id="mdl-provider">
            <SelectValue placeholder={t("models.form.providerPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <ProviderPickerGroups
              items={registry}
              featuredLabel={t("models.form.providerGroupFeatured")}
              otherLabel={t("models.form.providerGroupOther")}
              renderItem={(p) => {
                const Icon = getProviderIcon(p);
                return (
                  <SelectItem key={p.providerId} value={p.providerId}>
                    <span className="flex items-center gap-2">
                      {Icon && <Icon className="size-4" />}
                      {p.displayName}
                    </span>
                  </SelectItem>
                );
              }}
            />
          </SelectContent>
        </Select>
      </div>

      {isCustomProvider ? (
        /* An operator-supplied endpoint has no model list to wait for — the
           base URL and the model id are typed — so every field is available
           the moment the provider is picked, in the order it gets filled in:
           endpoint → key → model → name → capabilities. */
        <>
          {baseUrlFieldJsx}
          {credentialBlockJsx}
          {discoverJsx}
          {modelIdFieldJsx}
          {labelFieldJsx}
          {capabilitiesJsx}
        </>
      ) : (
        <>
          {/* OAuth (subscription) providers need the connection FIRST: the
              served model list depends on the account's plan, known only by
              probing the live credential. So the order flips to connection →
              probe → model. API-key / OpenRouter providers keep model-first
              (static catalog, no per-credential discovery). */}
          {isOauthProvider ? (
            <>
              {credentialBlockJsx}
              {/* Model dropdown is gated on the probe: it appears only once
                  refresh-models has returned the plan's verified ids (metadata
                  comes from the already-loaded registry catalog). A probe that
                  found nothing shows the empty-state instead of an empty
                  dropdown. */}
              {selectedCredential &&
                (() => {
                  const fresh = probeResult?.id === credentialId ? probeResult : null;
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
                  // override — including cost. We mark each setValue as dirty
                  // so the submit handler ships them.
                  setSelectedModelId(m.id);
                  setValue("modelId", m.id, { shouldDirty: true });
                  setValue("label", m.name, { shouldDirty: true });
                  if (m.contextWindow)
                    setValue("contextWindow", m.contextWindow.toString(), { shouldDirty: true });
                  if (m.maxTokens)
                    setValue("maxTokens", m.maxTokens.toString(), { shouldDirty: true });
                  setValue("inputText", m.input?.includes("text") !== false, { shouldDirty: true });
                  setValue("inputImage", m.input?.includes("image") ?? false, {
                    shouldDirty: true,
                  });
                  setValue("reasoning", m.reasoning ?? false, { shouldDirty: true });
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
          {modelIdFieldJsx}
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

export function ModelFormModal({ open, onClose, model, isPending, onSubmit }: ModelFormModalProps) {
  const { t } = useTranslation(["settings", "common"]);
  if (!open) return null;

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
          <Button type="submit" form="model-form" disabled={isPending}>
            {isPending ? <Spinner /> : t("btn.save")}
          </Button>
        </>
      }
    >
      {/* Key forces remount when the target model changes, resetting all state */}
      <ModelFormBody key={model?.id ?? "__create__"} model={model} onSubmit={onSubmit} />
    </Modal>
  );
}
