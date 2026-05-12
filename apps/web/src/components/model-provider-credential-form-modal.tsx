// SPDX-License-Identifier: Apache-2.0

/**
 * Unified credential modal — single entry point for both API-key and
 * OAuth model provider connections.
 *
 * The provider picker merges PROVIDER_PRESETS (api-key, hardcoded) and
 * OAuth providers contributed by modules via `useProvidersRegistry()`.
 * Selecting an OAuth provider swaps the body to the pairing-token UI
 * (`<OAuthPairingBody>`); api-key providers keep the form. Modules can
 * be added/removed via the `MODULES` env var with zero UI churn — their
 * OAuth tiles appear/disappear automatically.
 *
 * Edit mode is API-key-only — OAuth rows are immutable (label included)
 * and use the dedicated "reconnect" affordance, which re-enters the
 * modal with the same provider preselected to re-pair.
 */

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
import {
  useProvidersRegistry,
  useTestModelProviderCredentialInline,
  type ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import type { ModelProviderCredentialInfo, TestResult } from "@appstrate/shared-types";
import {
  CUSTOM_ID,
  PROVIDER_PRESETS,
  PI_ADAPTER_TYPES,
  findProviderByApiShapeAndBaseUrl,
} from "@/lib/model-presets";
import { PROVIDER_ICONS } from "./icons";
import { OAuthPairingBody } from "./oauth-pairing-body";

export interface ProviderKeyFormData {
  label: string;
  apiShape: string;
  baseUrl: string;
  apiKey?: string;
}

interface ProviderKeyFormModalProps {
  open: boolean;
  onClose: () => void;
  providerKey: ModelProviderCredentialInfo | null;
  /** Preselect an OAuth provider — used by the "reconnect" affordance on stale rows. */
  initialOauthProviderId?: string | null;
  isPending: boolean;
  onSubmit: (data: ProviderKeyFormData) => void;
}

interface ProviderKeyFormFields {
  label: string;
  apiShape: string;
  baseUrl: string;
  apiKey: string;
}

function detectProviderFromKey(key: ModelProviderCredentialInfo | null): string {
  if (!key) return "";
  const match = findProviderByApiShapeAndBaseUrl(key.apiShape, key.baseUrl);
  return match ? match.id : CUSTOM_ID;
}

/**
 * Unified pick-list option model. Sourced from PROVIDER_PRESETS
 * (api-key presets) + the dynamic OAuth registry. The renderer just
 * needs an id, label, and (for dispatch) an authMode.
 */
interface PickerOption {
  id: string;
  label: string;
  authMode: "api_key" | "oauth2";
  providerId?: string;
}

function buildOptions(oauthEntries: readonly ProviderRegistryEntry[]): PickerOption[] {
  const apiKeyOptions = PROVIDER_PRESETS.filter((p) => p.id !== "openrouter").map((p) => ({
    id: p.id,
    label: p.label,
    authMode: "api_key" as const,
  }));
  const oauthOptions = oauthEntries.map((p) => ({
    id: `oauth:${p.providerId}`,
    label: p.displayName,
    authMode: "oauth2" as const,
    providerId: p.providerId,
  }));
  return [...apiKeyOptions, ...oauthOptions];
}

function ProviderKeyFormBody({
  providerKey,
  initialOauthProviderId,
  isPending,
  onSubmit,
  onClose,
}: {
  providerKey: ModelProviderCredentialInfo | null;
  initialOauthProviderId: string | null;
  isPending: boolean;
  onSubmit: (data: ProviderKeyFormData) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const registryQuery = useProvidersRegistry();
  const oauthRegistry = (registryQuery.data ?? []).filter((p) => p.authMode === "oauth2");
  const options = buildOptions(oauthRegistry);

  const [selectedId, setSelectedId] = useState<string>(() => {
    if (initialOauthProviderId) return `oauth:${initialOauthProviderId}`;
    return detectProviderFromKey(providerKey);
  });

  const isEditing = !!providerKey;
  const selectedOption = options.find((o) => o.id === selectedId);
  const isOAuthSelected = selectedOption?.authMode === "oauth2";
  const isCustom = selectedId === CUSTOM_ID;

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
    setSelectedId(id);
    clearErrors();
    if (id === CUSTOM_ID) {
      setValue("apiShape", "");
      setValue("baseUrl", "");
      setValue("label", "");
      return;
    }
    const option = options.find((o) => o.id === id);
    if (!option || option.authMode === "oauth2") return;
    const provider = PROVIDER_PRESETS.find((p) => p.id === id);
    if (provider) {
      setValue("apiShape", provider.apiShape);
      setValue("baseUrl", provider.baseUrl);
      if (!label.trim()) setValue("label", provider.label);
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

  // OAuth-selected: the pairing body owns submission (helper POSTs creds
  // back). Hide the form-side Test/Save buttons; only Close stays.
  if (isOAuthSelected && selectedOption?.providerId) {
    return (
      <Modal
        open
        onClose={onClose}
        title={title}
        actions={
          <Button type="button" variant="outline" onClick={onClose}>
            {t("providerKeys.oauth.close")}
          </Button>
        }
      >
        <div className="space-y-4">
          {!isEditing && (
            <div className="space-y-2">
              <Label htmlFor="pk-provider">{t("providerKeys.form.provider")}</Label>
              <Select value={selectedId} onValueChange={handleProviderChange}>
                <SelectTrigger id="pk-provider">
                  <SelectValue placeholder={t("models.form.providerPlaceholder")} />
                </SelectTrigger>
                <SelectContent>{renderOptions(options, t)}</SelectContent>
              </Select>
            </div>
          )}
          <OAuthPairingBody
            key={selectedOption.providerId}
            providerId={selectedOption.providerId}
            onConnected={() => onClose()}
          />
        </div>
      </Modal>
    );
  }

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
        <div className="space-y-2">
          <Label htmlFor="pk-provider">{t("providerKeys.form.provider")}</Label>
          <Select value={selectedId} onValueChange={handleProviderChange} disabled={isEditing}>
            <SelectTrigger id="pk-provider">
              <SelectValue placeholder={t("models.form.providerPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {renderOptions(options, t)}
              <SelectItem value={CUSTOM_ID}>{t("models.form.custom")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

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

        {!!selectedId && (
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

function renderOptions(options: PickerOption[], t: (key: string) => string): React.ReactNode {
  return options.map((opt) => {
    const Icon = opt.authMode === "api_key" ? PROVIDER_ICONS[opt.id] : undefined;
    return (
      <SelectItem key={opt.id} value={opt.id}>
        <span className="flex items-center gap-2">
          {Icon && <Icon className="size-4" />}
          {opt.label}
          {opt.authMode === "oauth2" && (
            <span className="text-muted-foreground ml-1 text-[0.7rem] uppercase">
              {t("providerKeys.oauth.badgeOauth")}
            </span>
          )}
        </span>
      </SelectItem>
    );
  });
}

export function ModelProviderKeyFormModal({
  open,
  onClose,
  providerKey,
  initialOauthProviderId = null,
  isPending,
  onSubmit,
}: ProviderKeyFormModalProps) {
  if (!open) return null;
  // Re-mount on every (re)open so internal state (selected provider,
  // form values, pairing token if any) resets cleanly.
  const key = providerKey?.id ?? `__create__:${initialOauthProviderId ?? ""}`;
  return (
    <ProviderKeyFormBody
      key={key}
      providerKey={providerKey}
      initialOauthProviderId={initialOauthProviderId}
      isPending={isPending}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
