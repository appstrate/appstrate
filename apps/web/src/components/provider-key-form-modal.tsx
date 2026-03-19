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
import { useTestProviderKeyInline } from "../hooks/use-provider-keys";
import type { OrgProviderKeyInfo, TestResult } from "@appstrate/shared-types";
import {
  CUSTOM_ID,
  PROVIDER_PRESETS,
  API_TYPES,
  findProviderByApiAndBaseUrl,
} from "@/lib/model-presets";
import { PROVIDER_ICONS } from "./icons";

interface ProviderKeyFormData {
  label: string;
  api: string;
  baseUrl: string;
  apiKey?: string;
}

interface ProviderKeyFormModalProps {
  open: boolean;
  onClose: () => void;
  providerKey: OrgProviderKeyInfo | null;
  isPending: boolean;
  onSubmit: (data: ProviderKeyFormData) => void;
}

function detectProviderFromKey(key: OrgProviderKeyInfo | null): string {
  if (!key) return "";
  const match = findProviderByApiAndBaseUrl(key.api, key.baseUrl);
  return match ? match.id : CUSTOM_ID;
}

function ProviderKeyFormBody({
  providerKey,
  isPending,
  onSubmit,
  onClose,
}: {
  providerKey: OrgProviderKeyInfo | null;
  isPending: boolean;
  onSubmit: (data: ProviderKeyFormData) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [providerId, setProviderId] = useState(() => detectProviderFromKey(providerKey));
  const [label, setLabel] = useState(providerKey?.label ?? "");
  const [api, setApi] = useState(providerKey?.api ?? "");
  const [baseUrl, setBaseUrl] = useState(providerKey?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");

  const isCustom = providerId === CUSTOM_ID;

  const rules = useMemo(
    () => ({
      label: (v: string) => (!v.trim() ? t("validation.required", { ns: "common" }) : undefined),
      apiKey: (v: string) =>
        !providerKey && !v.trim() ? t("validation.required", { ns: "common" }) : undefined,
      baseUrl: (v: string) => {
        if (!isCustom) return undefined;
        if (!v.trim()) return t("validation.required", { ns: "common" });
        try {
          new URL(v.trim());
        } catch {
          return t("validation.required", { ns: "common" });
        }
        return undefined;
      },
      api: (v: string) =>
        isCustom && !v.trim() ? t("validation.required", { ns: "common" }) : undefined,
    }),
    [t, providerKey, isCustom],
  );

  const { errors, onBlur, validateAll, clearErrors, clearField } = useFormErrors(rules);

  const testMutation = useTestProviderKeyInline();
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const canTest = !!api.trim() && !!baseUrl.trim() && (!!apiKey.trim() || !!providerKey);

  const handleTest = () => {
    setTestResult(null);
    testMutation.mutate(
      {
        api: api.trim(),
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(providerKey ? { existingKeyId: providerKey.id } : {}),
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

  const handleProviderChange = (id: string) => {
    setProviderId(id);
    clearErrors();
    if (id === CUSTOM_ID) {
      setApi("");
      setBaseUrl("");
      setLabel("");
    } else {
      const provider = PROVIDER_PRESETS.find((p) => p.id === id);
      if (provider) {
        setApi(provider.api);
        setBaseUrl(provider.baseUrl);
        if (!label.trim()) setLabel(provider.label);
      }
    }
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!validateAll({ label, api, baseUrl, apiKey })) return;
    onSubmit({
      label: label.trim(),
      api: api.trim(),
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
  };

  const title = providerKey ? t("providerKeys.form.editTitle") : t("providerKeys.form.title");

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
              {testMutation.isPending ? <Spinner /> : t("providerKeys.test")}
            </Button>
            {testResult && (
              <span className={`text-sm ${testResult.ok ? "text-green-500" : "text-destructive"}`}>
                {testResult.ok
                  ? t("providerKeys.testSuccess", { latency: testResult.latency })
                  : t("providerKeys.testFailed", { message: testResult.message })}
              </span>
            )}
          </div>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button type="submit" form="pk-form" disabled={isPending}>
            {isPending ? <Spinner /> : t("btn.save")}
          </Button>
        </>
      }
    >
      <form id="pk-form" onSubmit={handleSubmit} className="space-y-4">
        {/* Provider select */}
        <div className="space-y-2">
          <Label htmlFor="pk-provider">{t("providerKeys.form.provider")}</Label>
          <Select value={providerId} onValueChange={handleProviderChange}>
            <SelectTrigger id="pk-provider">
              <SelectValue placeholder={t("models.form.providerPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_PRESETS.filter((p) => p.id !== "openrouter").map((p) => {
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

        {/* Label */}
        <div className="space-y-2">
          <Label htmlFor="pk-label">{t("providerKeys.form.label")}</Label>
          <Input
            id="pk-label"
            type="text"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              clearField("label");
            }}
            onBlur={() => onBlur("label", label)}
            placeholder="ex: My Anthropic Key"
            aria-invalid={errors.label ? true : undefined}
            className={cn(errors.label && "border-destructive")}
          />
          {errors.label && <div className="text-sm text-destructive">{errors.label}</div>}
        </div>

        {/* Custom provider fields */}
        {isCustom && (
          <>
            <div className="space-y-2">
              <Label htmlFor="pk-api">{t("models.form.api")}</Label>
              <Select
                value={api}
                onValueChange={(v) => {
                  setApi(v);
                  clearField("api");
                }}
              >
                <SelectTrigger id="pk-api" className={cn(errors.api && "border-destructive")}>
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
            <div className="space-y-2">
              <Label htmlFor="pk-baseUrl">{t("providerKeys.form.baseUrl")}</Label>
              <Input
                id="pk-baseUrl"
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
              {errors.baseUrl && <div className="text-sm text-destructive">{errors.baseUrl}</div>}
            </div>
          </>
        )}

        {/* API Key */}
        {!!providerId && (
          <div className="space-y-2">
            <Label htmlFor="pk-apiKey">{t("providerKeys.form.apiKey")}</Label>
            <Input
              id="pk-apiKey"
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
            {providerKey && (
              <div className="text-sm text-muted-foreground">
                {t("providerKeys.form.apiKeyHint")}
              </div>
            )}
            {errors.apiKey && <div className="text-sm text-destructive">{errors.apiKey}</div>}
          </div>
        )}
      </form>
    </Modal>
  );
}

export function ProviderKeyFormModal({
  open,
  onClose,
  providerKey,
  isPending,
  onSubmit,
}: ProviderKeyFormModalProps) {
  if (!open) return null;
  const key = providerKey?.id ?? "__create__";
  return (
    <ProviderKeyFormBody
      key={key}
      providerKey={providerKey}
      isPending={isPending}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
