import React, { useState, useMemo, useEffect } from "react";
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
import { useFormErrors } from "../hooks/use-form-errors";
import { useOpenRouterModels, type OpenRouterModel, type ModelCost } from "../hooks/use-models";
import { useProviderKeys } from "../hooks/use-provider-keys";
import type { OrgModelInfo } from "@appstrate/shared-types";
import {
  CUSTOM_ID,
  PROVIDER_PRESETS,
  API_TYPES,
  findPresetMatch,
  getProviderById,
  findProviderByApiAndBaseUrl,
} from "@/lib/model-presets";
import { PROVIDER_ICONS } from "./icons";

interface ModelFormData {
  label: string;
  api: string;
  baseUrl: string;
  modelId: string;
  providerKeyId: string;
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

function detectProvider(model: OrgModelInfo | null): string {
  if (!model) return "";
  const match = findPresetMatch(model.api, model.modelId);
  if (match) return match.provider.id;
  const byApiAndUrl = findProviderByApiAndBaseUrl(model.api, model.baseUrl);
  if (byApiAndUrl) return byApiAndUrl.id;
  return CUSTOM_ID;
}

function detectModel(model: OrgModelInfo | null): string {
  if (!model) return "";
  const match = findPresetMatch(model.api, model.modelId);
  if (match) return match.model.modelId;
  const byApiAndUrl = findProviderByApiAndBaseUrl(model.api, model.baseUrl);
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
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
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
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{m.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{m.id}</div>
                    </div>
                    {m.contextWindow && (
                      <span className="ml-2 shrink-0 text-xs text-muted-foreground">
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

  const [providerId, setProviderId] = useState(() => detectProvider(model));
  const [selectedModelId, setSelectedModelId] = useState(() => detectModel(model));

  const [label, setLabel] = useState(model?.label ?? "");
  const [api, setApi] = useState(model?.api ?? "");
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? "");
  const [modelId, setModelId] = useState(model?.modelId ?? "");
  const [inputText, setInputText] = useState(model?.input?.includes("text") !== false);
  const [inputImage, setInputImage] = useState(model?.input?.includes("image") ?? false);
  const [contextWindow, setContextWindow] = useState(model?.contextWindow?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(model?.maxTokens?.toString() ?? "");
  const [reasoning, setReasoning] = useState(model?.reasoning ?? false);
  const [cost, setCost] = useState<ModelCost | null>(null);

  const [providerKeyId, setProviderKeyId] = useState(model?.providerKeyId ?? "");
  const [inlineApiKey, setInlineApiKey] = useState("");
  const providerKeysQuery = useProviderKeys();

  const availableProviderKeys = useMemo(() => {
    if (!providerKeysQuery.data || !api || !baseUrl) return [];
    const normalizedBase = baseUrl.replace(/\/+$/, "");
    return providerKeysQuery.data.filter(
      (k) => k.api === api && k.baseUrl.replace(/\/+$/, "") === normalizedBase,
    );
  }, [providerKeysQuery.data, api, baseUrl]);

  const selectedKey = availableProviderKeys.find((k) => k.id === providerKeyId);
  const inlineKeyMode = !selectedKey && !providerKeyId;

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

  const selectedProvider = isCustomProvider ? undefined : getProviderById(providerId);

  const rules = useMemo(
    () => ({
      label: (v: string) => {
        if (isPreset) return undefined;
        if (!v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
      api: (v: string) => {
        if (!isCustomProvider) return undefined;
        if (!v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
      baseUrl: (v: string) => {
        if (isPreset) return undefined;
        if (!v.trim()) return t("validation.required", { ns: "common" });
        try {
          new URL(v.trim());
        } catch {
          return t("validation.required", { ns: "common" });
        }
        return undefined;
      },
      modelId: (v: string) => {
        if (isPreset) return undefined;
        if (!v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
      providerKeyId: (v: string) => {
        if (inlineKeyMode && inlineApiKey.trim()) return undefined;
        if (model) return undefined; // optional when editing
        if (!v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
    }),
    [t, model, isPreset, isCustomProvider, inlineKeyMode, inlineApiKey],
  );

  const { errors, onBlur, validateAll, clearErrors, clearField } = useFormErrors(rules);

  const resetModelFields = () => {
    setLabel("");
    setModelId("");
    setInputText(true);
    setInputImage(false);
    setContextWindow("");
    setMaxTokens("");
    setReasoning(false);
    setCost(null);
  };

  const handleProviderChange = (id: string) => {
    setProviderId(id);
    clearErrors();

    if (id === CUSTOM_ID) {
      setSelectedModelId(CUSTOM_ID);
      setApi("");
      setBaseUrl("");
    } else {
      setSelectedModelId("");
      const provider = getProviderById(id);
      if (provider) {
        setApi(provider.api);
        setBaseUrl(provider.baseUrl);
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

    setLabel(preset.label);
    setModelId(preset.modelId);
    setInputText(preset.input.includes("text"));
    setInputImage(preset.input.includes("image"));
    setContextWindow(preset.contextWindow.toString());
    setMaxTokens(preset.maxTokens.toString());
    setReasoning(preset.reasoning);
    setCost(preset.cost ?? null);
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!validateAll({ label, api, baseUrl, modelId, providerKeyId })) return;

    const inputArr = [inputText && "text", inputImage && "image"].filter(Boolean) as string[];
    const cw = contextWindow.trim() ? parseInt(contextWindow.trim(), 10) : undefined;
    const mt = maxTokens.trim() ? parseInt(maxTokens.trim(), 10) : undefined;

    onSubmit({
      label: label.trim(),
      api: api.trim(),
      baseUrl: baseUrl.trim(),
      modelId: modelId.trim(),
      providerKeyId: inlineKeyMode ? "" : providerKeyId,
      ...(inlineKeyMode && inlineApiKey.trim()
        ? { newProviderKey: { apiKey: inlineApiKey.trim() } }
        : {}),
      ...(inputArr.length > 0 ? { input: inputArr } : {}),
      ...(cw ? { contextWindow: cw } : {}),
      ...(mt ? { maxTokens: mt } : {}),
      ...(reasoning ? { reasoning: true } : {}),
      ...(cost ? { cost } : {}),
    });
  };

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
      <form id="model-form" onSubmit={handleSubmit} className="space-y-4">
        {/* Provider select */}
        <div className="space-y-2">
          <Label htmlFor="mdl-provider">{t("models.form.provider")}</Label>
          <Select value={providerId} onValueChange={handleProviderChange}>
            <SelectTrigger id="mdl-provider">
              <SelectValue placeholder={t("models.form.providerPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_PRESETS.map((p) => {
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
                setModelId(m.id);
                setLabel(m.name);
                if (m.contextWindow) setContextWindow(m.contextWindow.toString());
                if (m.maxTokens) setMaxTokens(m.maxTokens.toString());
                setInputText(m.input?.includes("text") !== false);
                setInputImage(m.input?.includes("image") ?? false);
                setReasoning(m.reasoning ?? false);
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
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                clearField("label");
              }}
              onBlur={() => onBlur("label", label)}
              placeholder="ex: Claude Sonnet"
              autoFocus
              aria-invalid={errors.label ? true : undefined}
              className={cn(errors.label && "border-destructive")}
            />
            {errors.label && <div className="text-sm text-destructive">{errors.label}</div>}
          </div>
        )}

        {/* Provider key — visible once a model is chosen */}
        {(!!selectedModelId || (isOpenRouter && !!modelId)) && (
          <div className="space-y-2">
            <Label>{t("providerKeys.form.apiKey")}</Label>
            {selectedKey ? (
              <div className="flex gap-2">
                <div className="flex-1 flex items-center gap-2 h-9 rounded-md border border-input bg-muted px-3 text-sm">
                  <KeyRound className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{selectedKey.label}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 h-9 w-9"
                  onClick={() => {
                    setProviderKeyId("");
                    setInlineApiKey("");
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
                  value={inlineApiKey}
                  onChange={(e) => {
                    setInlineApiKey(e.target.value);
                    clearField("providerKeyId");
                  }}
                  placeholder="sk-..."
                  className={cn("flex-1", errors.providerKeyId && "border-destructive")}
                  aria-invalid={errors.providerKeyId ? true : undefined}
                />
                {availableProviderKeys.length > 0 && (
                  <Select
                    value=""
                    onValueChange={(id) => {
                      setProviderKeyId(id);
                      setInlineApiKey("");
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
              <div className="text-sm text-muted-foreground">
                {t("models.form.createProviderKeyHint")}
              </div>
            )}
            {errors.providerKeyId && (
              <div className="text-sm text-destructive">{errors.providerKeyId}</div>
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
                  value={api}
                  onValueChange={(v) => {
                    setApi(v);
                    clearField("api");
                  }}
                >
                  <SelectTrigger id="mdl-api" className={cn(errors.api && "border-destructive")}>
                    <SelectValue placeholder={t("models.form.apiPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {API_TYPES.map((apiType) => (
                      <SelectItem key={apiType.value} value={apiType.value}>
                        {apiType.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.api && <div className="text-sm text-destructive">{errors.api}</div>}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="mdl-baseUrl">{t("models.form.baseUrl")}</Label>
              <Input
                id="mdl-baseUrl"
                type="url"
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  clearField("baseUrl");
                }}
                onBlur={() => onBlur("baseUrl", baseUrl)}
                placeholder="https://api.openai.com/v1"
                aria-invalid={errors.baseUrl ? true : undefined}
                className={cn(errors.baseUrl && "border-destructive")}
              />
              <div className="text-sm text-muted-foreground">{t("models.form.baseUrlHint")}</div>
              {errors.baseUrl && <div className="text-sm text-destructive">{errors.baseUrl}</div>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="mdl-modelId">{t("models.form.modelId")}</Label>
              <Input
                id="mdl-modelId"
                type="text"
                value={modelId}
                onChange={(e) => {
                  setModelId(e.target.value);
                  clearField("modelId");
                }}
                onBlur={() => onBlur("modelId", modelId)}
                placeholder="ex: claude-sonnet-4-5-20250929"
                aria-invalid={errors.modelId ? true : undefined}
                className={cn(errors.modelId && "border-destructive")}
              />
              {errors.modelId && <div className="text-sm text-destructive">{errors.modelId}</div>}
            </div>
          </>
        )}

        {/* Capabilities — visible for custom provider/model only (preset + OpenRouter auto-fill from source of truth) */}
        {isCustom && (
          <div className="border-t pt-4 mt-2 space-y-4">
            <Label className="text-sm font-medium text-muted-foreground">
              {t("models.form.capabilities")}
            </Label>
            <div className="space-y-2">
              <Label>{t("models.form.input")}</Label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={inputText}
                    onChange={(e) => setInputText(e.target.checked)}
                  />
                  {t("models.form.inputText")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={inputImage}
                    onChange={(e) => setInputImage(e.target.checked)}
                  />
                  {t("models.form.inputImage")}
                </label>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="mdl-ctx">{t("models.form.contextWindow")}</Label>
                <Input
                  id="mdl-ctx"
                  type="number"
                  value={contextWindow}
                  onChange={(e) => setContextWindow(e.target.value)}
                  placeholder="200000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mdl-maxtok">{t("models.form.maxTokens")}</Label>
                <Input
                  id="mdl-maxtok"
                  type="number"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  placeholder="16384"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="mdl-reasoning"
                type="checkbox"
                checked={reasoning}
                onChange={(e) => setReasoning(e.target.checked)}
              />
              <Label htmlFor="mdl-reasoning">{t("models.form.reasoning")}</Label>
            </div>
            <div className="text-sm text-muted-foreground">{t("models.form.capabilitiesHint")}</div>
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
