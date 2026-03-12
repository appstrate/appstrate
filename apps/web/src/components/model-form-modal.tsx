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
import type { OrgModelInfo } from "@appstrate/shared-types";

const API_DEFAULT_URLS: Record<string, string> = {
  "anthropic-messages": "https://api.anthropic.com",
  "openai-completions": "https://api.openai.com/v1",
  "google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
};

interface ModelFormModalProps {
  open: boolean;
  onClose: () => void;
  model: OrgModelInfo | null;
  isPending: boolean;
  onSubmit: (data: {
    label: string;
    api: string;
    baseUrl: string;
    modelId: string;
    apiKey: string;
  }) => void;
}

function ModelFormBody({
  model,
  isPending,
  onSubmit,
  onClose,
}: {
  model: OrgModelInfo | null;
  isPending: boolean;
  onSubmit: (data: {
    label: string;
    api: string;
    baseUrl: string;
    modelId: string;
    apiKey: string;
  }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [label, setLabel] = useState(model?.label ?? "");
  const [api, setApi] = useState(model?.api ?? "");
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? "");
  const [modelId, setModelId] = useState(model?.modelId ?? "");
  const [apiKey, setApiKey] = useState("");

  const rules = useMemo(
    () => ({
      label: (v: string) => {
        if (!v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
      api: (v: string) => {
        if (!v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
      baseUrl: (v: string) => {
        if (!v.trim()) return t("validation.required", { ns: "common" });
        try {
          new URL(v.trim());
        } catch {
          return t("validation.required", { ns: "common" });
        }
        return undefined;
      },
      modelId: (v: string) => {
        if (!v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
      apiKey: (v: string) => {
        if (!model && !v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
    }),
    [t, model],
  );

  const { errors, onBlur, validateAll, clearField } = useFormErrors(rules);

  const handleApiChange = (value: string) => {
    setApi(value);
    clearField("api");
    if (!baseUrl && API_DEFAULT_URLS[value]) {
      setBaseUrl(API_DEFAULT_URLS[value]);
      clearField("baseUrl");
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateAll({ label, api, baseUrl, modelId, apiKey })) return;

    onSubmit({
      label: label.trim(),
      api: api.trim(),
      baseUrl: baseUrl.trim(),
      modelId: modelId.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    } as { label: string; api: string; baseUrl: string; modelId: string; apiKey: string });
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
        <div className="space-y-2">
          <Label htmlFor="mdl-api">{t("models.form.api")}</Label>
          <Select value={api} onValueChange={handleApiChange}>
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
