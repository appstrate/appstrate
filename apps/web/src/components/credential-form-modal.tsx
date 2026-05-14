// SPDX-License-Identifier: Apache-2.0

/**
 * Unified credential modal — single entry point for both API-key and
 * OAuth model provider connections.
 *
 * The provider picker is fully sourced from `useProvidersRegistry()` —
 * api-key and OAuth providers alike. Selecting an OAuth provider swaps
 * the body to the pairing-token UI (`<OAuthPairingBody>`); api-key
 * providers keep the form. Modules can be added/removed via the
 * `MODULES` env var with zero client churn — their entries appear or
 * disappear in the picker automatically.
 *
 * The form posts the canonical `{ label, providerId, apiKey, baseUrlOverride? }`
 * shape. The `baseUrlOverride` field is only surfaced for providers that
 * declare `baseUrlOverridable: true` (today: `openai-compatible`, exposed
 * via the picker's "Custom" entry as the self-hosted escape hatch).
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
import { getProviderById, resolveProviderId } from "@/lib/provider-registry-helpers";
import { PROVIDER_ICONS } from "./icons";
import { ProviderPickerGroups } from "./provider-picker-groups";
import { OAuthPairingBody } from "./oauth-pairing-body";

/**
 * Canonical payload shape submitted to `POST /api/model-provider-credentials`.
 * `baseUrlOverride` is only meaningful for providers with `baseUrlOverridable: true`
 * (today: `openai-compatible`).
 */
export interface CredentialFormData {
  label: string;
  providerId: string;
  apiKey?: string;
  baseUrlOverride?: string | null;
}

interface CredentialFormModalProps {
  open: boolean;
  onClose: () => void;
  credential: ModelProviderCredentialInfo | null;
  /** Preselect an OAuth provider — used by the "reconnect" affordance on stale rows. */
  initialOauthProviderId?: string | null;
  isPending: boolean;
  onSubmit: (data: CredentialFormData) => void;
}

interface CredentialFormFields {
  label: string;
  apiKey: string;
  baseUrlOverride: string;
}

/**
 * Unified pick-list option model. Built entirely from the registry —
 * api-key entries surface as plain `providerId` options, OAuth entries
 * are prefixed `oauth:` to keep the dispatch unambiguous. Openrouter
 * stays out of the credential picker (managed via the model form's
 * dedicated combobox).
 */
interface PickerOption {
  id: string;
  label: string;
  authMode: "api_key" | "oauth2";
  providerId: string;
  featured: boolean;
}

function buildOptions(registry: readonly ProviderRegistryEntry[]): PickerOption[] {
  return registry
    .filter((p) => p.providerId !== "openrouter")
    .map((p) => ({
      id: p.authMode === "oauth2" ? `oauth:${p.providerId}` : p.providerId,
      label: p.displayName,
      authMode: p.authMode,
      providerId: p.providerId,
      featured: p.featured,
    }));
}

function CredentialFormBody({
  credential,
  initialOauthProviderId,
  isPending,
  onSubmit,
  onClose,
}: {
  credential: ModelProviderCredentialInfo | null;
  initialOauthProviderId: string | null;
  isPending: boolean;
  onSubmit: (data: CredentialFormData) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const registryQuery = useProvidersRegistry();
  const registry = registryQuery.data ?? [];
  const options = buildOptions(registry);

  const [selectedId, setSelectedId] = useState<string>(() => {
    if (initialOauthProviderId) return `oauth:${initialOauthProviderId}`;
    return credential ? resolveProviderId(credential, registry) : "";
  });

  const isEditing = !!credential;
  const selectedOption = options.find((o) => o.id === selectedId);
  const isOAuthSelected = selectedOption?.authMode === "oauth2";
  const selectedProvider = selectedOption
    ? getProviderById(selectedOption.providerId, registry)
    : undefined;
  const needsBaseUrlOverride = !!selectedProvider?.baseUrlOverridable;

  const {
    register,
    handleSubmit,
    control,
    setValue,
    clearErrors,
    showError,
    formState: { errors },
  } = useAppForm<CredentialFormFields>({
    defaultValues: {
      label: credential?.label ?? "",
      apiKey: "",
      baseUrlOverride: credential?.baseUrl ?? "",
    },
  });

  const [baseUrlOverride, apiKey, label] = useWatch({
    control,
    name: ["baseUrlOverride", "apiKey", "label"],
  });

  const testMutation = useTestModelProviderCredentialInline();
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  // Inline-test endpoint still takes (apiShape, baseUrl) — these are
  // computed from the chosen provider's registry entry (+ override).
  const testApiShape = selectedProvider?.apiShape ?? "";
  const testBaseUrl = needsBaseUrlOverride
    ? baseUrlOverride.trim()
    : (selectedProvider?.defaultBaseUrl ?? "");
  const canTest =
    !!selectedProvider &&
    !isOAuthSelected &&
    !!testApiShape &&
    !!testBaseUrl &&
    (!!apiKey.trim() || !!credential);

  const handleTest = () => {
    setTestResult(null);
    testMutation.mutate(
      {
        apiShape: testApiShape,
        baseUrl: testBaseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(credential ? { existingKeyId: credential.id } : {}),
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
    const option = options.find((o) => o.id === id);
    if (!option || option.authMode === "oauth2") {
      setValue("baseUrlOverride", "");
      return;
    }
    const provider = getProviderById(option.providerId, registry);
    if (provider) {
      // Pre-seed the override field with the default base URL so users
      // see the value they're customising. Non-overridable providers
      // never read this field.
      setValue("baseUrlOverride", provider.baseUrlOverridable ? provider.defaultBaseUrl : "");
      if (!label.trim()) setValue("label", provider.displayName);
    }
  };

  const onFormSubmit = handleSubmit((data) => {
    if (!selectedProvider) return;
    onSubmit({
      label: data.label.trim(),
      providerId: selectedProvider.providerId,
      ...(data.apiKey.trim() ? { apiKey: data.apiKey.trim() } : {}),
      ...(needsBaseUrlOverride && data.baseUrlOverride.trim()
        ? { baseUrlOverride: data.baseUrlOverride.trim() }
        : {}),
    });
  });

  const title = credential ? t("credentials.form.editTitle") : t("credentials.form.title");

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
            {t("credentials.oauth.close")}
          </Button>
        }
      >
        <div className="space-y-4">
          {!isEditing && (
            <div className="space-y-2">
              <Label htmlFor="pk-provider">{t("credentials.form.provider")}</Label>
              <Select value={selectedId} onValueChange={handleProviderChange}>
                <SelectTrigger id="pk-provider">
                  <SelectValue placeholder={t("models.form.providerPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <ProviderPickerGroups
                    items={options}
                    featuredLabel={t("models.form.providerGroupFeatured")}
                    otherLabel={t("models.form.providerGroupOther")}
                    renderItem={(option) => (
                      <PickerOptionItem key={option.id} option={option} t={t} />
                    )}
                  />
                </SelectContent>
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
              {testMutation.isPending ? <Spinner /> : t("credentials.test")}
            </Button>
            {testResult && (
              <span className={`text-sm ${testResult.ok ? "text-green-500" : "text-destructive"}`}>
                {testResult.ok
                  ? t("credentials.testSuccess", { latency: testResult.latency })
                  : t("credentials.testFailed", { message: testResult.message })}
              </span>
            )}
          </div>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button type="submit" form="pk-form" disabled={isPending || !selectedProvider}>
            {isPending ? <Spinner /> : t("btn.save")}
          </Button>
        </>
      }
    >
      <form id="pk-form" onSubmit={onFormSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="pk-provider">{t("credentials.form.provider")}</Label>
          <Select value={selectedId} onValueChange={handleProviderChange} disabled={isEditing}>
            <SelectTrigger id="pk-provider">
              <SelectValue placeholder={t("models.form.providerPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <ProviderPickerGroups
                items={options}
                featuredLabel={t("models.form.providerGroupFeatured")}
                otherLabel={t("models.form.providerGroupOther")}
                renderItem={(option) => <PickerOptionItem key={option.id} option={option} t={t} />}
              />
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="pk-label">{t("credentials.form.label")}</Label>
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

        {needsBaseUrlOverride && (
          <div className="space-y-2">
            <Label htmlFor="pk-baseUrl">{t("credentials.form.baseUrl")}</Label>
            <Input
              id="pk-baseUrl"
              type="url"
              disabled={isEditing}
              {...register("baseUrlOverride", {
                validate: (v) => {
                  if (!needsBaseUrlOverride) return undefined;
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
              aria-invalid={showError("baseUrlOverride") ? true : undefined}
              className={cn(showError("baseUrlOverride") && "border-destructive")}
            />
            {showError("baseUrlOverride") && errors.baseUrlOverride?.message && (
              <div className="text-destructive text-sm">{errors.baseUrlOverride.message}</div>
            )}
          </div>
        )}

        {!!selectedProvider && (
          <div className="space-y-2">
            <Label htmlFor="pk-apiKey">{t("credentials.form.apiKey")}</Label>
            <Input
              id="pk-apiKey"
              type="password"
              {...register("apiKey", {
                validate: (v) =>
                  !credential && !v.trim() ? t("validation.required", { ns: "common" }) : undefined,
              })}
              placeholder="sk-..."
              aria-invalid={showError("apiKey") ? true : undefined}
              className={cn(showError("apiKey") && "border-destructive")}
            />
            {credential && (
              <div className="text-muted-foreground text-sm">
                {t("credentials.form.apiKeyHint")}
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

function PickerOptionItem({
  option,
  t,
}: {
  option: PickerOption;
  t: (key: string) => string;
}): React.ReactNode {
  const Icon = PROVIDER_ICONS[option.providerId];
  return (
    <SelectItem key={option.id} value={option.id}>
      <span className="flex items-center gap-2">
        {Icon && <Icon className="size-4" />}
        {option.label}
        {option.authMode === "oauth2" && (
          <span className="text-muted-foreground ml-1 text-[0.7rem] uppercase">
            {t("credentials.oauth.badgeOauth")}
          </span>
        )}
      </span>
    </SelectItem>
  );
}

export function CredentialFormModal({
  open,
  onClose,
  credential,
  initialOauthProviderId = null,
  isPending,
  onSubmit,
}: CredentialFormModalProps) {
  if (!open) return null;
  // Re-mount on every (re)open so internal state (selected provider,
  // form values, pairing token if any) resets cleanly.
  const key = credential?.id ?? `__create__:${initialOauthProviderId ?? ""}`;
  return (
    <CredentialFormBody
      key={key}
      credential={credential}
      initialOauthProviderId={initialOauthProviderId}
      isPending={isPending}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
