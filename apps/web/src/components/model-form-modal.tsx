// SPDX-License-Identifier: Apache-2.0

import React, { useState, useMemo, useEffect } from "react";
import { useWatch } from "react-hook-form";
import { useAppForm } from "../hooks/use-app-form";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Check, ChevronsUpDown, KeyRound, X } from "lucide-react";
import { useOpenRouterModels, type OpenRouterModel, type ModelCost } from "../hooks/use-models";
import {
  useModelProviderCredentials,
  useProvidersRegistry,
  type ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import type { OrgModelInfo } from "@appstrate/shared-types";
import {
  CUSTOM_ID,
  PROVIDER_PRESETS,
  PI_ADAPTER_TYPES,
  findPresetMatch,
  getProviderById,
  findProviderByApiShapeAndBaseUrl,
  type ProviderPreset,
} from "@/lib/model-presets";

/**
 * Adapt the API's `/registry` entries into the modal's `ProviderPreset`
 * shape so OAuth-subscription providers (Codex, Claude Code) participate in
 * the picker without being statically duplicated in `model-presets.ts`.
 */
function registryToPresets(entries: ProviderRegistryEntry[] | undefined): ProviderPreset[] {
  if (!entries) return [];
  return entries.map((p) => ({
    id: p.providerId,
    label: p.displayName,
    apiShape: p.apiShape,
    baseUrl: p.defaultBaseUrl,
    models: p.models.map((m) => ({
      modelId: m.id,
      label: m.id,
      input: [...m.capabilities].filter(
        (c): c is "text" | "image" => c === "text" || c === "image",
      ),
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens ?? 0,
      reasoning: m.capabilities.includes("reasoning"),
    })),
  }));
}
import { PROVIDER_ICONS } from "./icons";

export interface ModelFormData {
  label: string;
  apiShape: string;
  baseUrl: string;
  modelId: string;
  credentialId: string;
  newProviderKey?: { apiKey: string };
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

function detectProvider(
  model: OrgModelInfo | null,
  extraProviders: readonly ProviderPreset[] = [],
): string {
  if (!model) return "";
  const match = findPresetMatch(model.apiShape, model.modelId, extraProviders);
  if (match) return match.provider.id;
  const byApiAndUrl = findProviderByApiShapeAndBaseUrl(
    model.apiShape,
    model.baseUrl,
    extraProviders,
  );
  if (byApiAndUrl) return byApiAndUrl.id;
  return CUSTOM_ID;
}

function detectModel(
  model: OrgModelInfo | null,
  extraProviders: readonly ProviderPreset[] = [],
): string {
  if (!model) return "";
  const match = findPresetMatch(model.apiShape, model.modelId, extraProviders);
  if (match) return match.model.modelId;
  const byApiAndUrl = findProviderByApiShapeAndBaseUrl(
    model.apiShape,
    model.baseUrl,
    extraProviders,
  );
  if (byApiAndUrl) {
    // Providers with no static presets (e.g. OpenRouter) use dynamic model IDs
    if (byApiAndUrl.models.length === 0) return model.modelId;
    return CUSTOM_ID;
  }
  return CUSTOM_ID;
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
  const registryPresets = useMemo(
    () => registryToPresets(registryQuery.data),
    [registryQuery.data],
  );
  // Picker dropdown — static presets first, then registry-only OAuth providers.
  const pickerPresets = useMemo(
    () => [
      ...PROVIDER_PRESETS,
      ...registryPresets.filter((rp) => !PROVIDER_PRESETS.some((p) => p.id === rp.id)),
    ],
    [registryPresets],
  );

  // User-driven provider/model overrides — `null` means "follow auto-detect".
  // Detection runs through `registryPresets` so OAuth-backed models resolve
  // correctly once the registry hook resolves.
  const [providerOverride, setProviderOverride] = useState<string | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [cost, setCost] = useState<ModelCost | null>(null);

  const providerId = providerOverride ?? detectProvider(model, registryPresets);
  const selectedModelId = modelOverride ?? detectModel(model, registryPresets);
  const setProviderId = (id: string) => setProviderOverride(id);
  const setSelectedModelId = (id: string) => setModelOverride(id);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    clearErrors,
    showError,
    formState: { errors },
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

  const providerKeysQuery = useModelProviderCredentials();

  const availableProviderKeys = useMemo(() => {
    if (!providerKeysQuery.data || !apiShape || !baseUrl) return [];
    const normalizedBase = baseUrl.replace(/\/+$/, "");
    return providerKeysQuery.data.filter(
      (k) => k.apiShape === apiShape && k.baseUrl.replace(/\/+$/, "") === normalizedBase,
    );
  }, [providerKeysQuery.data, apiShape, baseUrl]);

  const selectedKey = availableProviderKeys.find((k) => k.id === credentialId);
  const inlineKeyMode = !selectedKey && !credentialId;

  const [openRouterSearch, setOpenRouterSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(openRouterSearch), 300);
    return () => clearTimeout(timer);
  }, [openRouterSearch]);

  const openRouterQuery = useOpenRouterModels(
    providerId === "openrouter" ? debouncedSearch : undefined,
  );

  const isOpenRouter = providerId === "openrouter";
  const isCustomProvider = providerId === CUSTOM_ID;
  const isCustomModel = selectedModelId === CUSTOM_ID;
  const isPreset = !isCustomProvider && !isCustomModel && !!selectedModelId;
  const isCustom = isCustomProvider || isCustomModel;

  const selectedProvider = isCustomProvider
    ? undefined
    : getProviderById(providerId, registryPresets);

  const resetModelFields = () => {
    setValue("label", "");
    setValue("modelId", "");
    setValue("inputText", true);
    setValue("inputImage", false);
    setValue("contextWindow", "");
    setValue("maxTokens", "");
    setValue("reasoning", false);
    setCost(null);
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
      const provider = getProviderById(id, registryPresets);
      if (provider) {
        setValue("apiShape", provider.apiShape);
        setValue("baseUrl", provider.baseUrl);
      }
    }
    resetModelFields();
    setOpenRouterSearch("");
  };

  const handleModelChange = (id: string) => {
    setSelectedModelId(id);
    clearErrors();

    if (id === CUSTOM_ID) {
      resetModelFields();
      return;
    }

    const preset = selectedProvider?.models.find((m) => m.modelId === id);
    if (!preset) return;

    setValue("label", preset.label);
    setValue("modelId", preset.modelId);
    setValue("inputText", preset.input.includes("text"));
    setValue("inputImage", preset.input.includes("image"));
    setValue("contextWindow", preset.contextWindow.toString());
    setValue("maxTokens", preset.maxTokens.toString());
    setValue("reasoning", preset.reasoning);
    setCost(preset.cost ?? null);
  };

  const onFormSubmit = handleSubmit((data) => {
    const inputArr = [data.inputText && "text", data.inputImage && "image"].filter(
      Boolean,
    ) as string[];
    const cw = data.contextWindow.trim() ? parseInt(data.contextWindow.trim(), 10) : undefined;
    const mt = data.maxTokens.trim() ? parseInt(data.maxTokens.trim(), 10) : undefined;

    onSubmit({
      label: data.label.trim(),
      apiShape: data.apiShape.trim(),
      baseUrl: data.baseUrl.trim(),
      modelId: data.modelId.trim(),
      credentialId: inlineKeyMode ? "" : data.credentialId,
      ...(inlineKeyMode && data.inlineApiKey.trim()
        ? { newProviderKey: { apiKey: data.inlineApiKey.trim() } }
        : {}),
      ...(inputArr.length > 0 ? { input: inputArr } : {}),
      ...(cw ? { contextWindow: cw } : {}),
      ...(mt ? { maxTokens: mt } : {}),
      ...(data.reasoning ? { reasoning: true } : {}),
      ...(cost ? { cost } : {}),
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
              {pickerPresets.map((p) => {
                const Icon = PROVIDER_ICONS[p.id];
                return (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex items-center gap-2">
                      {Icon && <Icon className="size-4" />}
                      {p.label}
                    </span>
                  </SelectItem>
                );
              })}
              <SelectItem value={CUSTOM_ID}>{t("models.form.custom")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Model select (only for known providers, except OpenRouter) */}
        {selectedProvider && !isOpenRouter && (
          <div className="space-y-2">
            <Label htmlFor="mdl-model">{t("models.form.modelId")}</Label>
            <Select value={selectedModelId} onValueChange={handleModelChange}>
              <SelectTrigger id="mdl-model">
                <SelectValue placeholder={t("models.form.modelPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {selectedProvider.models.map((m) => (
                  <SelectItem key={m.modelId} value={m.modelId}>
                    {m.label}
                  </SelectItem>
                ))}
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
              search={openRouterSearch}
              onSearchChange={setOpenRouterSearch}
              models={openRouterQuery.data ?? []}
              isLoading={openRouterQuery.isLoading}
              placeholder={t("models.form.openRouterSearchPlaceholder")}
              emptyText={t("models.form.openRouterNoResults")}
              searchingText={t("models.form.openRouterSearching")}
              onSelect={(m) => {
                setSelectedModelId(m.id);
                setValue("modelId", m.id);
                setValue("label", m.name);
                if (m.contextWindow) setValue("contextWindow", m.contextWindow.toString());
                if (m.maxTokens) setValue("maxTokens", m.maxTokens.toString());
                setValue("inputText", m.input?.includes("text") !== false);
                setValue("inputImage", m.input?.includes("image") ?? false);
                setValue("reasoning", m.reasoning ?? false);
                setCost(m.cost ?? null);
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

        {/* Provider key — visible once a model is chosen */}
        {(!!selectedModelId || (isOpenRouter && !!modelId)) && (
          <div className="space-y-2">
            <Label>{t("providerKeys.form.apiKey")}</Label>
            {selectedKey ? (
              <div className="flex gap-2">
                <div className="border-input bg-muted flex h-9 flex-1 items-center gap-2 rounded-md border px-3 text-sm">
                  <KeyRound className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="truncate">{selectedKey.label}</span>
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
                  <span className="sr-only">Clear</span>
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Input
                  type="password"
                  {...register("inlineApiKey")}
                  placeholder="sk-..."
                  className={cn("flex-1", showError("credentialId") && "border-destructive")}
                  aria-invalid={showError("credentialId") ? true : undefined}
                />
                {availableProviderKeys.length > 0 && (
                  <Select
                    value=""
                    onValueChange={(id) => {
                      setValue("credentialId", id);
                      setValue("inlineApiKey", "");
                    }}
                  >
                    <SelectTrigger className="w-auto shrink-0">
                      <SelectValue placeholder={t("models.form.useExistingKey")} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableProviderKeys.map((k) => (
                        <SelectItem key={k.id} value={k.id}>
                          {k.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
            {!selectedKey && inlineApiKey.trim() && (
              <div className="text-muted-foreground text-sm">
                {t("models.form.createProviderKeyHint")}
              </div>
            )}
            {showError("credentialId") && errors.credentialId?.message && (
              <div className="text-destructive text-sm">{errors.credentialId.message}</div>
            )}
          </div>
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
          <div className="mt-2 space-y-4 border-t pt-4">
            <Label className="text-muted-foreground text-sm font-medium">
              {t("models.form.capabilities")}
            </Label>
            <div className="space-y-2">
              <Label>{t("models.form.input")}</Label>
              <div className="flex gap-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="mdl-input-text"
                    checked={inputText}
                    onCheckedChange={(checked) => setValue("inputText", Boolean(checked))}
                  />
                  <Label htmlFor="mdl-input-text" className="cursor-pointer font-normal">
                    {t("models.form.inputText")}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="mdl-input-image"
                    checked={inputImage}
                    onCheckedChange={(checked) => setValue("inputImage", Boolean(checked))}
                  />
                  <Label htmlFor="mdl-input-image" className="cursor-pointer font-normal">
                    {t("models.form.inputImage")}
                  </Label>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="mdl-ctx">{t("models.form.contextWindow")}</Label>
                <Input
                  id="mdl-ctx"
                  type="number"
                  {...register("contextWindow")}
                  placeholder="200000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mdl-maxtok">{t("models.form.maxTokens")}</Label>
                <Input
                  id="mdl-maxtok"
                  type="number"
                  {...register("maxTokens")}
                  placeholder="16384"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="mdl-reasoning"
                checked={reasoning}
                onCheckedChange={(checked) => setValue("reasoning", Boolean(checked))}
              />
              <Label htmlFor="mdl-reasoning" className="cursor-pointer font-normal">
                {t("models.form.reasoning")}
              </Label>
            </div>
            <div className="text-muted-foreground text-sm">{t("models.form.capabilitiesHint")}</div>
          </div>
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
