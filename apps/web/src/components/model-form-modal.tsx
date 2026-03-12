import { useState, useMemo } from "react";
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
import { useFormErrors } from "../hooks/use-form-errors";
import { useTestModelInline } from "../hooks/use-models";
import type { OrgModelInfo, TestResult } from "@appstrate/shared-types";
import {
  CUSTOM_ID,
  PROVIDER_PRESETS,
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
  apiKey: string;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
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
  if (byApiAndUrl) return CUSTOM_ID;
  return CUSTOM_ID;
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
  const [apiKey, setApiKey] = useState("");
  const [inputText, setInputText] = useState(model?.input?.includes("text") !== false);
  const [inputImage, setInputImage] = useState(model?.input?.includes("image") ?? false);
  const [contextWindow, setContextWindow] = useState(model?.contextWindow?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(model?.maxTokens?.toString() ?? "");
  const [reasoning, setReasoning] = useState(model?.reasoning ?? false);

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
      apiKey: (v: string) => {
        if (!model && !v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
    }),
    [t, model, isPreset, isCustomProvider],
  );

  const { errors, onBlur, validateAll, clearErrors, clearField } = useFormErrors(rules);

  // --- Inline test ---
  const testMutation = useTestModelInline();
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const canTest =
    !!api.trim() && !!baseUrl.trim() && !!modelId.trim() && (!!apiKey.trim() || !!model);

  const handleTest = () => {
    setTestResult(null);
    testMutation.mutate(
      {
        api: api.trim(),
        baseUrl: baseUrl.trim(),
        modelId: modelId.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(model ? { existingModelId: model.id } : {}),
      },
      {
        onSuccess: (result) => setTestResult(result),
        onError: () =>
          setTestResult({
            ok: false,
            latency: 0,
            error: "NETWORK_ERROR",
            message: "Request failed",
          }),
      },
    );
  };

  const resetModelFields = () => {
    setLabel("");
    setModelId("");
    setInputText(true);
    setInputImage(false);
    setContextWindow("");
    setMaxTokens("");
    setReasoning(false);
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
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateAll({ label, api, baseUrl, modelId, apiKey })) return;

    const inputArr = [inputText && "text", inputImage && "image"].filter(Boolean) as string[];
    const cw = contextWindow.trim() ? parseInt(contextWindow.trim()) : undefined;
    const mt = maxTokens.trim() ? parseInt(maxTokens.trim()) : undefined;

    onSubmit({
      label: label.trim(),
      api: api.trim(),
      baseUrl: baseUrl.trim(),
      modelId: modelId.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(inputArr.length > 0 ? { input: inputArr } : {}),
      ...(cw ? { contextWindow: cw } : {}),
      ...(mt ? { maxTokens: mt } : {}),
      ...(reasoning ? { reasoning: true } : {}),
    } as ModelFormData);
  };

  const title = model ? t("models.form.editTitle") : t("models.form.title");

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      actions={
        <>
          <div className="flex items-center gap-2 mr-auto">
            <Button
              type="button"
              variant="outline"
              onClick={handleTest}
              disabled={!canTest || testMutation.isPending}
            >
              {testMutation.isPending ? <Spinner /> : t("models.test")}
            </Button>
            {testResult && (
              <span className={`text-sm ${testResult.ok ? "text-green-500" : "text-destructive"}`}>
                {testResult.ok
                  ? t("models.testSuccess", { latency: testResult.latency })
                  : t("models.testFailed", { message: testResult.message })}
              </span>
            )}
          </div>
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

        {/* Model select (only for known providers) */}
        {selectedProvider && (
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

        {/* API Key — visible once a model is chosen */}
        {!!selectedModelId && (
          <div className="space-y-2">
            <Label htmlFor="mdl-apiKey">{t("models.form.apiKey")}</Label>
            <Input
              id="mdl-apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                clearField("apiKey");
              }}
              onBlur={() => onBlur("apiKey", apiKey)}
              placeholder="sk-..."
              aria-invalid={errors.apiKey ? true : undefined}
              className={cn(errors.apiKey && "border-destructive")}
            />
            {model && (
              <div className="text-sm text-muted-foreground">{t("models.form.apiKeyHint")}</div>
            )}
            {errors.apiKey && <div className="text-sm text-destructive">{errors.apiKey}</div>}
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
                    <SelectItem value="anthropic-messages">Anthropic</SelectItem>
                    <SelectItem value="openai-completions">OpenAI / Compatible</SelectItem>
                    <SelectItem value="google-generative-ai">Google AI</SelectItem>
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
              <div className="text-sm text-muted-foreground">
                {t("models.form.capabilitiesHint")}
              </div>
            </div>
          </>
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
