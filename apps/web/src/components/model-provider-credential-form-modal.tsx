// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
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
import { useTestModelProviderCredentialInline } from "../hooks/use-model-provider-credentials";
import type { OrgModelProviderKeyInfo, TestResult } from "@appstrate/shared-types";
import {
  CUSTOM_ID,
  PROVIDER_PRESETS,
  API_TYPES,
  findProviderByApiShapeAndBaseUrl,
} from "@/lib/model-presets";
import { PROVIDER_ICONS } from "./icons";

interface ProviderKeyFormData {
  label: string;
  apiShape: string;
  baseUrl: string;
  apiKey?: string;
}

interface ProviderKeyFormModalProps {
  open: boolean;
  onClose: () => void;
  providerKey: OrgModelProviderKeyInfo | null;
  isPending: boolean;
  onSubmit: (data: ProviderKeyFormData) => void;
}

interface ProviderKeyFormFields {
  label: string;
  apiShape: string;
  baseUrl: string;
  apiKey: string;
}

function detectProviderFromKey(key: OrgModelProviderKeyInfo | null): string {
  if (!key) return "";
  const match = findProviderByApiShapeAndBaseUrl(key.apiShape, key.baseUrl);
  return match ? match.id : CUSTOM_ID;
}

function ProviderKeyFormBody({
  providerKey,
  isPending,
  onSubmit,
  onClose,
}: {
  providerKey: OrgModelProviderKeyInfo | null;
  isPending: boolean;
  onSubmit: (data: ProviderKeyFormData) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [providerId, setProviderId] = useState(() => detectProviderFromKey(providerKey));

  const isEditing = !!providerKey;
  const isCustom = providerId === CUSTOM_ID;

  const {
    register,
    handleSubmit,
    control,
    setValue,
    clearErrors,
    showError,
    formState: { errors },
  } = useAppForm<ProviderKeyFormFields>({
    defaultValues: {
      label: providerKey?.label ?? "",
      apiShape: providerKey?.apiShape ?? "",
      baseUrl: providerKey?.baseUrl ?? "",
      apiKey: "",
    },
  });

  const [apiShape, baseUrl, apiKey, label] = useWatch({
    control,
    name: ["apiShape", "baseUrl", "apiKey", "label"],
  });

  const testMutation = useTestModelProviderCredentialInline();
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const canTest = !!apiShape.trim() && !!baseUrl.trim() && (!!apiKey.trim() || !!providerKey);

  const handleTest = () => {
    setTestResult(null);
    testMutation.mutate(
      {
        apiShape: apiShape.trim(),
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
      setValue("apiShape", "");
      setValue("baseUrl", "");
      setValue("label", "");
    } else {
      const provider = PROVIDER_PRESETS.find((p) => p.id === id);
      if (provider) {
        setValue("apiShape", provider.apiShape);
        setValue("baseUrl", provider.baseUrl);
        if (!label.trim()) setValue("label", provider.label);
      }
    }
  };

  const onFormSubmit = handleSubmit((data) => {
    onSubmit({
      label: data.label.trim(),
      apiShape: data.apiShape.trim(),
      baseUrl: data.baseUrl.trim(),
      ...(data.apiKey.trim() ? { apiKey: data.apiKey.trim() } : {}),
    });
  });

  const title = providerKey ? t("providerKeys.form.editTitle") : t("providerKeys.form.title");

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      actions={
        <>
          <div className="mr-auto flex items-center gap-2">
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
      <form id="pk-form" onSubmit={onFormSubmit} className="space-y-4">
        {/* Provider select */}
        <div className="space-y-2">
          <Label htmlFor="pk-provider">{t("providerKeys.form.provider")}</Label>
          <Select value={providerId} onValueChange={handleProviderChange} disabled={isEditing}>
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
            {...register("label", {
              validate: (v) => (!v.trim() ? t("validation.required", { ns: "common" }) : undefined),
            })}
            placeholder="ex: My Anthropic Key"
            aria-invalid={showError("label") ? true : undefined}
            className={cn(showError("label") && "border-destructive")}
          />
          {showError("label") && errors.label?.message && (
            <div className="text-destructive text-sm">{errors.label.message}</div>
          )}
        </div>

        {/* Custom provider fields */}
        {isCustom && (
          <>
            <div className="space-y-2">
              <Label htmlFor="pk-api">{t("models.form.api")}</Label>
              <Select
                value={apiShape}
                onValueChange={(v) => {
                  setValue("apiShape", v);
                  clearErrors("apiShape");
                }}
                disabled={isEditing}
              >
                <SelectTrigger
                  id="pk-api"
                  className={cn(showError("apiShape") && "border-destructive")}
                >
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
              {showError("apiShape") && errors.apiShape?.message && (
                <div className="text-destructive text-sm">{errors.apiShape.message}</div>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="pk-baseUrl">{t("providerKeys.form.baseUrl")}</Label>
              <Input
                id="pk-baseUrl"
                type="url"
                disabled={isEditing}
                {...register("baseUrl", {
                  validate: (v) => {
                    if (!isCustom) return undefined;
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
              {showError("baseUrl") && errors.baseUrl?.message && (
                <div className="text-destructive text-sm">{errors.baseUrl.message}</div>
              )}
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
              {...register("apiKey", {
                validate: (v) =>
                  !providerKey && !v.trim()
                    ? t("validation.required", { ns: "common" })
                    : undefined,
              })}
              placeholder="sk-..."
              aria-invalid={showError("apiKey") ? true : undefined}
              className={cn(showError("apiKey") && "border-destructive")}
            />
            {providerKey && (
              <div className="text-muted-foreground text-sm">
                {t("providerKeys.form.apiKeyHint")}
              </div>
            )}
            {showError("apiKey") && errors.apiKey?.message && (
              <div className="text-destructive text-sm">{errors.apiKey.message}</div>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}

export function ModelProviderKeyFormModal({
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
