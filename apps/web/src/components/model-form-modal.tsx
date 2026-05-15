// SPDX-License-Identifier: Apache-2.0

import React, { useState, useMemo, useEffect } from "react";
import { useWatch } from "react-hook-form";
import { useAppForm } from "../hooks/use-app-form";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProviderPickerGroups } from "./provider-picker-groups";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Check, ChevronsUpDown, KeyRound, Plug, X } from "lucide-react";
import { type OpenRouterModel } from "../hooks/use-models";
import type { ModelCost } from "@appstrate/core/module";
import { CapabilitiesSection } from "./model-form/capabilities-section";
import { useOpenRouterSearch } from "./model-form/use-open-router-search";
import {
  useModelProviderCredentials,
  useProvidersRegistry,
} from "../hooks/use-model-provider-credentials";
import { OAuthPairingBody } from "./oauth-pairing-body";
import type { OrgModelInfo } from "@appstrate/shared-types";
import {
  CUSTOM_ID,
  PI_ADAPTER_TYPES,
  getProviderById,
  resolveModelEntryId,
  resolveProviderId,
} from "@/lib/provider-registry-helpers";
import { getProviderIcon } from "./icons";

export interface ModelFormData {
  /**
   * Optional — server derives from the catalog label (`<catalog>.label`)
   * and dedupes against existing org rows when absent. Sent only when the
   * user explicitly customized it.
   */
  label?: string;
  modelId: string;
  credentialId: string;
  newCredential?: { apiKey: string; providerId: string; baseUrlOverride?: string };
  /**
   * Catalog-derivable overrides. Sent only when the user edited them after
   * picking a preset (RHF `dirtyFields`) — keeps existing rows in sync with
   * the weekly `refresh-pricing-catalog.ts` bump.
   */
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: ModelCost;
}

interface ModelFormModalProps {
  open: boolean;
  onClose: () => void;
  model: OrgModelInfo | null;
  isPending: boolean;
  onSubmit: (data: ModelFormData) => void;
}

interface ModelFormFields {
  label: string;
  apiShape: string;
  baseUrl: string;
  modelId: string;
  credentialId: string;
  inlineApiKey: string;
  inputText: boolean;
  inputImage: boolean;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
}

function OpenRouterCombobox({
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
  models: OpenRouterModel[];
  isLoading: boolean;
  placeholder: string;
  emptyText: string;
  searchingText: string;
  onSelect: (m: OpenRouterModel) => void;
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

function ModelFormBody({
  model,
  isPending,
  onSubmit,
  onClose,
}: {
  model: OrgModelInfo | null;
  isPending: boolean;
  onSubmit: (data: ModelFormData) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  const registryQuery = useProvidersRegistry();
  const registry = useMemo(() => registryQuery.data ?? [], [registryQuery.data]);
  // openai-compatible is the operator escape hatch (free-form baseUrl, no
  // catalog) and surfaces as the "Custom" option instead of a picker entry.
  // OpenRouter has no curated catalog — its row stays so users can pick it
  // and search models via the dedicated combobox.
  //
  // The picker is split into two visual sections — "Featured" (the
  // module-declared canonical providers operators usually want) and
  // "Other" (everything else). The flag is metadata only; no write path
  // gates on it, so any entry remains selectable from either group.
  const pickerEntries = useMemo(
    () => registry.filter((p) => p.providerId !== "openai-compatible"),
    [registry],
  );

  // User-driven provider/model overrides — `null` means "follow auto-detect".
  const [providerOverride, setProviderOverride] = useState<string | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [cost, setCost] = useState<ModelCost | null>(null);
  /**
   * True once the user explicitly edits cost (or imports an OpenRouter cost
   * different from the catalog). Cost lives outside RHF, so we track its
   * dirty state separately — on submit, we only send `cost` when the user
   * really overrode it, otherwise the server's catalog fallback applies.
   */
  const [costEdited, setCostEdited] = useState(false);

  const providerId = providerOverride ?? (model ? resolveProviderId(model, registry) : "");
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
        k.baseUrl.replace(/\/+$/, "") === normalizedBase,
    );
  }, [credentialsQuery.data, apiShape, baseUrl, isOauthProvider, providerId]);

  const selectedKey = availableCredentials.find((k) => k.id === credentialId);
  // For api-key providers, the third state is "no selection + about to type
  // a new key inline". For OAuth providers there's no inline path — the
  // user must either pick or click "Connect".
  const inlineKeyMode = !isOauthProvider && !selectedKey && !credentialId;

  // OAuth connect dialog — the pairing endpoint now returns the new
  // credentialId directly via `onConnected`, so we auto-select it in the
  // form without diffing the credential list.
  const [oauthDialogOpen, setOauthDialogOpen] = useState(false);

  const handleOpenOauthDialog = () => {
    setOauthDialogOpen(true);
  };

  const handleOauthConnected = (newId: string) => {
    setValue("credentialId", newId);
    setValue("inlineApiKey", "");
    clearErrors("credentialId");
  };

  const isOpenRouter = providerId === "openrouter";
  const openRouterSearch = useOpenRouterSearch(isOpenRouter);
  const isCustomProvider = providerId === CUSTOM_ID;
  const isCustomModel = selectedModelId === CUSTOM_ID;
  const isPreset = !isCustomProvider && !isCustomModel && !!selectedModelId;
  const isCustom = isCustomProvider || isCustomModel;

  const selectedProvider = isCustomProvider ? undefined : getProviderById(providerId, registry);

  const resetModelFields = () => {
    setValue("label", "");
    setValue("modelId", "");
    setValue("inputText", true);
    setValue("inputImage", false);
    setValue("contextWindow", "");
    setValue("maxTokens", "");
    setValue("reasoning", false);
    setCost(null);
    setCostEdited(false);
  };

  const handleProviderChange = (id: string) => {
    setProviderId(id);
    clearErrors();

    if (id === CUSTOM_ID) {
      setSelectedModelId(CUSTOM_ID);
      setValue("apiShape", "");
      setValue("baseUrl", "");
    } else {
      setSelectedModelId("");
      const provider = getProviderById(id, registry);
      if (provider) {
        setValue("apiShape", provider.apiShape);
        setValue("baseUrl", provider.defaultBaseUrl);
      }
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
    // Display the catalog cost in the UI without flagging it as "edited".
    // Server-side `resolveCatalogDefaults` will resolve it on read, so we
    // intentionally omit it from the POST payload.
    setCost(
      preset.cost
        ? {
            input: preset.cost.input,
            output: preset.cost.output,
            cacheRead: preset.cost.cacheRead ?? 0,
            cacheWrite: preset.cost.cacheWrite ?? 0,
          }
        : null,
    );
    setCostEdited(false);
  };

  const onFormSubmit = handleSubmit((data) => {
    const inputArr = [data.inputText && "text", data.inputImage && "image"].filter(
      Boolean,
    ) as string[];
    const cw = data.contextWindow.trim() ? parseInt(data.contextWindow.trim(), 10) : undefined;
    const mt = data.maxTokens.trim() ? parseInt(data.maxTokens.trim(), 10) : undefined;

    // Inline api-key creation only applies to api_key providers — OAuth
    // credentials must exist before the model is saved (they're created via
    // the pairing dialog and auto-selected into `credentialId`).
    const willCreateNewKey =
      !isOauthProvider && inlineKeyMode && data.inlineApiKey.trim().length > 0;

    // OAuth path requires a selected credential — there's no "type your key
    // inline" affordance, so emptiness is a hard error. The api-key path
    // accepts either an existing selection OR an inline new key; the route
    // handler validates the latter further down.
    if (isOauthProvider && !data.credentialId) {
      setError("credentialId", { message: t("models.form.connectionRequired") });
      return;
    }
    if (!isOauthProvider && !data.credentialId && !willCreateNewKey) {
      setError("credentialId", { message: t("models.form.apiKeyRequired") });
      return;
    }

    // Per-field dirty tracking: handleModelChange uses raw setValue (no
    // shouldDirty) so preset-derived values never mark fields dirty. Only
    // values the user actually edited after the preset (or that came from
    // OpenRouter live-search) are flagged. Catalog-derivable fields that
    // stayed at their preset values are omitted from the payload — the
    // server's `resolveCatalogDefaults` resolves them on read so weekly
    // catalog refreshes propagate. Same rationale for `label` (custom
    // input only) and `cost` (tracked separately because it lives outside
    // RHF).
    const labelDirty = dirtyFields.label === true;
    const inputDirty = dirtyFields.inputText === true || dirtyFields.inputImage === true;
    const cwDirty = dirtyFields.contextWindow === true;
    const mtDirty = dirtyFields.maxTokens === true;
    const reasoningDirty = dirtyFields.reasoning === true;

    onSubmit({
      ...(labelDirty && data.label.trim() ? { label: data.label.trim() } : {}),
      modelId: data.modelId.trim(),
      credentialId: willCreateNewKey ? "" : data.credentialId,
      // Inline credential creation needs the providerId (and optionally a
      // baseUrlOverride for `openai-compatible`) — the caller wires this up
      // through POST /api/model-provider-credentials before saving the model.
      ...(willCreateNewKey
        ? {
            newCredential: {
              apiKey: data.inlineApiKey.trim(),
              providerId,
              ...(isCustomProvider && data.baseUrl.trim()
                ? { baseUrlOverride: data.baseUrl.trim() }
                : {}),
            },
          }
        : {}),
      ...(inputDirty && inputArr.length > 0 ? { input: inputArr } : {}),
      ...(cwDirty && cw ? { contextWindow: cw } : {}),
      ...(mtDirty && mt ? { maxTokens: mt } : {}),
      ...(reasoningDirty ? { reasoning: data.reasoning } : {}),
      ...(costEdited && cost ? { cost } : {}),
    });
  });

  const title = model ? t("models.form.editTitle") : t("models.form.title");

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
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
                items={pickerEntries}
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
              <SelectItem value={CUSTOM_ID}>{t("models.form.custom")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Model select (only for known providers, except OpenRouter).
            Catalog-covered providers expose 50-100+ models — split
            "Featured" (curated whitelist) from "All models" (the rest of
            the LiteLLM catalog). Non-catalog providers (codex, openai-
            compatible) only return their inline list with featured=false,
            so the All-models group collects everything in that case. */}
        {selectedProvider && !isOpenRouter && selectedProvider.models.length > 0 && (
          <div className="space-y-2">
            <Label htmlFor="mdl-model">{t("models.form.modelId")}</Label>
            <Select value={selectedModelId} onValueChange={handleModelChange}>
              <SelectTrigger id="mdl-model">
                <SelectValue placeholder={t("models.form.modelPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <ProviderPickerGroups
                  items={selectedProvider.models}
                  featuredLabel={t("models.form.modelGroupFeatured")}
                  otherLabel={t("models.form.modelGroupAll")}
                  renderItem={(m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label ?? m.id}
                    </SelectItem>
                  )}
                />
                <SelectItem value={CUSTOM_ID}>{t("models.form.custom")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {/* OpenRouter model search (combobox) */}
        {isOpenRouter && (
          <div className="space-y-2">
            <Label>{t("models.form.modelId")}</Label>
            <OpenRouterCombobox
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
                setValue("inputImage", m.input?.includes("image") ?? false, { shouldDirty: true });
                setValue("reasoning", m.reasoning ?? false, { shouldDirty: true });
                setCost(m.cost ?? null);
                setCostEdited(m.cost != null);
              }}
            />
          </div>
        )}

        {/* Label — only for custom provider/model */}
        {isCustom && (
          <div className="space-y-2">
            <Label htmlFor="mdl-label">{t("models.form.label")}</Label>
            <Input
              id="mdl-label"
              type="text"
              {...register("label", {
                validate: (v) => {
                  if (isPreset) return undefined;
                  if (!v.trim()) return t("validation.required", { ns: "common" });
                  return undefined;
                },
              })}
              placeholder="ex: Claude Sonnet"
              autoFocus
              aria-invalid={showError("label") ? true : undefined}
              className={cn(showError("label") && "border-destructive")}
            />
            {showError("label") && errors.label?.message && (
              <div className="text-destructive text-sm">{errors.label.message}</div>
            )}
          </div>
        )}

        {/* Credential — visible once a model is chosen.
            Two flavors keyed on the provider's authMode:
              - OAuth: select an existing connection OR launch the pairing
                dialog. No inline secret input.
              - API key: type a new key inline OR pick an existing credential. */}
        {(!!selectedModelId || (isOpenRouter && !!modelId)) && (
          <div className="space-y-2">
            <Label>
              {isOauthProvider ? t("models.form.connectionLabel") : t("credentials.form.apiKey")}
            </Label>

            {selectedKey ? (
              <div className="flex gap-2">
                <div className="border-input bg-muted flex h-9 flex-1 items-center gap-2 rounded-md border px-3 text-sm">
                  {isOauthProvider ? (
                    <Plug className="text-muted-foreground size-3.5 shrink-0" />
                  ) : (
                    <KeyRound className="text-muted-foreground size-3.5 shrink-0" />
                  )}
                  <span className="truncate">{selectedKey.label}</span>
                  {isOauthProvider && selectedKey.oauthEmail && (
                    <span className="text-muted-foreground truncate text-xs">
                      ({selectedKey.oauthEmail})
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
                            {k.oauthEmail && (
                              <span className="text-muted-foreground truncate text-xs">
                                {k.oauthEmail}
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
                  className={cn(
                    "min-w-0 flex-1",
                    showError("credentialId") && "border-destructive",
                  )}
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

            {!selectedKey && !isOauthProvider && inlineApiKey.trim() && (
              <div className="text-muted-foreground text-sm">
                {t("models.form.createCredentialHint")}
              </div>
            )}
            {!selectedKey && isOauthProvider && (
              <div className="text-muted-foreground text-sm">
                {t("models.form.connectProviderHint")}
              </div>
            )}
            {showError("credentialId") && errors.credentialId?.message && (
              <div className="text-destructive text-sm">{errors.credentialId.message}</div>
            )}
          </div>
        )}

        {oauthDialogOpen && (
          <Modal
            open
            onClose={() => setOauthDialogOpen(false)}
            title={t("credentials.oauth.cliStageTitle")}
            actions={
              <Button variant="ghost" onClick={() => setOauthDialogOpen(false)}>
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
            />
          </Modal>
        )}

        {/* Custom fields — visible for custom provider or custom model */}
        {isCustom && (
          <>
            {isCustomProvider && (
              <div className="space-y-2">
                <Label htmlFor="mdl-api">{t("models.form.api")}</Label>
                <Select
                  value={apiShape}
                  onValueChange={(v) => {
                    setValue("apiShape", v);
                    clearErrors("apiShape");
                  }}
                >
                  <SelectTrigger
                    id="mdl-api"
                    className={cn(showError("apiShape") && "border-destructive")}
                  >
                    <SelectValue placeholder={t("models.form.apiPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {PI_ADAPTER_TYPES.map((apiType) => (
                      <SelectItem key={apiType.value} value={apiType.value}>
                        {apiType.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {showError("apiShape") && errors.apiShape?.message && (
                  <div className="text-destructive text-sm">{errors.apiShape.message}</div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="mdl-baseUrl">{t("models.form.baseUrl")}</Label>
              <Input
                id="mdl-baseUrl"
                type="url"
                {...register("baseUrl", {
                  validate: (v) => {
                    if (isPreset) return undefined;
                    if (!v.trim()) return t("validation.required", { ns: "common" });
                    try {
                      new URL(v.trim());
                    } catch {
                      return t("validation.required", { ns: "common" });
                    }
                    return undefined;
                  },
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

            <div className="space-y-2">
              <Label htmlFor="mdl-modelId">{t("models.form.modelId")}</Label>
              <Input
                id="mdl-modelId"
                type="text"
                {...register("modelId", {
                  validate: (v) => {
                    if (isPreset) return undefined;
                    if (!v.trim()) return t("validation.required", { ns: "common" });
                    return undefined;
                  },
                })}
                placeholder="ex: claude-sonnet-4-5-20250929"
                aria-invalid={showError("modelId") ? true : undefined}
                className={cn(showError("modelId") && "border-destructive")}
              />
              {showError("modelId") && errors.modelId?.message && (
                <div className="text-destructive text-sm">{errors.modelId.message}</div>
              )}
            </div>
          </>
        )}

        {/* Capabilities — visible for custom provider/model only (preset + OpenRouter auto-fill from source of truth) */}
        {isCustom && (
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
        )}
      </form>
    </Modal>
  );
}

export function ModelFormModal({ open, onClose, model, isPending, onSubmit }: ModelFormModalProps) {
  if (!open) return null;

  // Key forces remount when model changes, resetting all state
  const key = model?.id ?? "__create__";

  return (
    <ModelFormBody
      key={key}
      model={model}
      isPending={isPending}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
