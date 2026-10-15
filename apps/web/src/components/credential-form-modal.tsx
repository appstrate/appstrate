// SPDX-License-Identifier: Apache-2.0

/**
 * Unified credential modal for both API-key and OAuth model provider connections. The
 * picker is sourced entirely from `useProvidersRegistry()` (module entries appear with
 * `MODULES`); an OAuth provider swaps the body to the pairing-token UI.
 *
 * `baseUrlOverridable` providers collapse into the picker's single "custom endpoint" row,
 * configured through the shared endpoint fields. Renaming is never done here
 * (`InlineEditableLabel`); editing a key row changes its key; an OAuth row changes only
 * through the reconnect affordance, and no key is ever sent for it.
 */

import { PendingButton } from "@/components/app-ui/pending-button";
import { useState } from "react";
import { useWatch } from "react-hook-form";
import { useAppForm } from "../hooks/use-app-form";
import { useTranslation } from "react-i18next";
import { FormModal } from "./form-modal";
import { TestResultSpan } from "./test-result-span";
import { FormItem } from "@/components/app-ui/form-item";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import {
  useProvidersRegistry,
  useTestModelProviderCredentialInline,
  type ProviderRegistryEntry,
  type ModelProviderCredentialInfo,
} from "../hooks/use-model-provider-credentials";
import type { TestResult } from "@appstrate/shared-types";
import {
  buildProviderPickerRows,
  CUSTOM_ENDPOINT_ID,
  getProviderById,
  pickedProviderId,
  resolveProviderId,
} from "@/lib/provider-registry-helpers";
import { parsesAsUrl } from "@/lib/model-discovery";
import { EndpointFields } from "./model-form/endpoint-fields";
import { CustomEndpointItem } from "./model-form/provider-picker";
import { PROVIDER_ICONS } from "./icons";
import { ProviderPickerGroups } from "./provider-picker-groups";
import { PairingModal } from "./pairing-modal";
import { PreferencesModelsLink } from "./preferences-models-link";

/** Payload of `POST /api/model-provider-credentials`; `baseUrlOverride` only for a base-URL-overridable entry. */
export interface CredentialFormData {
  label: string;
  providerId: string;
  apiKey?: string;
  baseUrlOverride?: string | null;
}

interface CredentialFormModalProps {
  onClose: () => void;
  credential: ModelProviderCredentialInfo | null;
  isPending: boolean;
  onSubmit: (data: CredentialFormData) => void;
  /**
   * The caller's own credential: the picker offers only what a member may own. Otherwise the
   * credential is the organization's, a key or a subscription.
   */
  personal?: boolean;
  /** The key being added comes back here from the next step with what was typed. */
  initial?: CredentialFormData;
  /** Replaces « Save » when the form is a step, not the whole act. */
  submitLabel?: string;
}

interface CredentialFormFields {
  label: string;
  apiKey: string;
  baseUrlOverride: string;
}

/** Pick-list option built from the registry; OAuth entries are prefixed `oauth:` to keep dispatch unambiguous. */
interface PickerOption {
  id: string;
  label: string;
  authMode: "api_key" | "oauth2";
  providerId: string;
  iconUrl: string;
  featured: boolean;
  baseUrlOverridable: boolean;
}

function buildOptions(registry: readonly ProviderRegistryEntry[]): PickerOption[] {
  return registry.map((p) => ({
    id: p.authMode === "oauth2" ? `oauth:${p.providerId}` : p.providerId,
    label: p.displayName,
    authMode: p.authMode,
    providerId: p.providerId,
    iconUrl: p.iconUrl,
    featured: p.featured,
    baseUrlOverridable: p.baseUrlOverridable,
  }));
}

/**
 * Mounted by the caller while open, one per credential (`key`): the picked provider, the typed
 * values and any pairing token start fresh on every open.
 */
export function CredentialFormModal({
  credential,
  isPending,
  onSubmit,
  onClose,
  personal = false,
  initial,
  submitLabel,
}: CredentialFormModalProps) {
  const { t } = useTranslation(["settings", "common"]);
  const registryQuery = useProvidersRegistry();
  const registry = registryQuery.data ?? [];
  const options = buildOptions(personal ? registry.filter((p) => p.personal_allowed) : registry);

  const [selectedId, setSelectedId] = useState<string>(() => {
    if (initial) return initial.providerId;
    if (credential?.providerId) {
      return credential.authMode === "oauth2"
        ? `oauth:${credential.providerId}`
        : credential.providerId;
    }
    return credential ? resolveProviderId(credential, registry) : "";
  });

  const isEditing = !!credential;
  const selectedOption = options.find((o) => o.id === selectedId);
  const isOAuthSelected = selectedOption?.authMode === "oauth2";
  const selectedProvider = selectedOption
    ? getProviderById(selectedOption.providerId, registry)
    : undefined;
  const needsBaseUrlOverride = !!selectedProvider?.baseUrlOverridable;
  const overridableProviders = registry.filter((p) => p.baseUrlOverridable);
  const pickerRows = buildProviderPickerRows(options);
  const pickerValue = needsBaseUrlOverride ? CUSTOM_ENDPOINT_ID : selectedId;

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
      label: credential?.label ?? initial?.label ?? "",
      apiKey: initial?.apiKey ?? "",
      baseUrlOverride: credential?.base_url ?? initial?.baseUrlOverride ?? "",
    },
  });

  const [baseUrlOverride, apiKey, label] = useWatch({
    control,
    name: ["baseUrlOverride", "apiKey", "label"],
  });

  const testMutation = useTestModelProviderCredentialInline();
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const testBaseUrl = needsBaseUrlOverride
    ? baseUrlOverride.trim()
    : (selectedProvider?.defaultBaseUrl ?? "");
  const canTest =
    !!selectedProvider && !isOAuthSelected && !!testBaseUrl && (!!apiKey.trim() || !!credential);

  const handleTest = () => {
    if (!selectedProvider) return;
    setTestResult(null);
    testMutation.mutate(
      {
        body: {
          providerId: selectedProvider.providerId,
          base_url: testBaseUrl,
          ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
          ...(credential ? { credentialId: credential.id } : {}),
        },
      },
      {
        onSuccess: (result) => setTestResult(result),
        onError: () =>
          setTestResult({
            ok: false,
            latency: 0,
            error: "INTERNAL_ERROR",
            message: t("test.failed", { ns: "common" }),
          }),
      },
    );
  };

  /** An auto-filled name follows the picked entry; a typed one is left alone. */
  const applyProviderName = (provider: ProviderRegistryEntry) => {
    const current = label.trim();
    if (!current || current === selectedProvider?.displayName) {
      setValue("label", provider.displayName);
    }
  };

  const handleProviderChange = (picked: string) => {
    const id = pickedProviderId(picked, registry);
    setSelectedId(id);
    clearErrors();
    const option = options.find((o) => o.id === id);
    if (!option || option.authMode === "oauth2") {
      setValue("baseUrlOverride", "");
      return;
    }
    const provider = getProviderById(option.providerId, registry);
    if (provider) {
      // Pre-seed the default base URL so users see the value they are customising.
      setValue("baseUrlOverride", provider.baseUrlOverridable ? provider.defaultBaseUrl : "");
      applyProviderName(provider);
    }
  };

  // The URL follows the new entry, the typed key stays.
  const handleApiTypeChange = (entry: ProviderRegistryEntry) => {
    setSelectedId(entry.providerId);
    clearErrors();
    setValue("baseUrlOverride", entry.defaultBaseUrl);
    applyProviderName(entry);
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

  const baseUrlValidate = (v: string) => {
    if (!v.trim()) return t("validation.required", { ns: "common" });
    return parsesAsUrl(v) ? undefined : t("validation.urlFormat", { ns: "common" });
  };
  // Editing keeps the stored key when nothing is typed.
  const apiKeyValidate = (v: string) =>
    !credential && !v.trim() ? t("validation.required", { ns: "common" }) : undefined;

  const title = !credential
    ? t(personal ? "credentials.form.titlePersonal" : "credentials.form.title")
    : isOAuthSelected
      ? t("credentials.form.reconnectTitle", { label: credential.label })
      : t("credentials.form.editTitle", { label: credential.label });

  const providerPicker = (
    <Select value={pickerValue} onValueChange={handleProviderChange} disabled={isEditing}>
      <SelectTrigger id="pk-provider">
        <SelectValue placeholder={t("models.form.providerPlaceholder")} />
      </SelectTrigger>
      <SelectContent>
        <ProviderPickerGroups
          items={pickerRows}
          featuredLabel={t("models.form.modelGroupFeatured")}
          otherLabel={t("models.form.providerGroupOther")}
          renderItem={(row) =>
            row.kind === "customEndpoint" ? (
              <CustomEndpointItem key={CUSTOM_ENDPOINT_ID} />
            ) : (
              <PickerOptionItem key={row.entry.id} option={row.entry} t={t} />
            )
          }
        />
      </SelectContent>
    </Select>
  );

  const labelField = (
    <FormItem
      id="pk-label"
      label={t("credentials.form.label")}
      error={showError("label") ? errors.label?.message : undefined}
    >
      <Input
        type="text"
        {...register("label", {
          validate: (v) => (!v.trim() ? t("validation.required", { ns: "common" }) : undefined),
        })}
        placeholder={t("credentials.form.labelPlaceholder")}
      />
    </FormItem>
  );

  // OAuth-selected: the pairing body owns the connection (the helper POSTs creds back). An
  // existing row is re-paired only when flagged and the server allows the caller to reconnect it.
  if (isOAuthSelected && selectedOption?.providerId) {
    const showPairing = credential
      ? !!credential.needs_reconnection && credential.allowed_actions.includes("reconnect")
      : true;
    return (
      <PairingModal
        title={title}
        onClose={onClose}
        providerId={selectedOption.providerId}
        target={
          credential ? { credentialId: credential.id } : { ownerType: personal ? "user" : "org" }
        }
        onConnected={() => onClose()}
        showPairing={showPairing}
      >
        {!isEditing && (
          <div className="space-y-2">
            <Label htmlFor="pk-provider">{t("credentials.form.provider")}</Label>
            {providerPicker}
          </div>
        )}
      </PairingModal>
    );
  }

  return (
    <FormModal
      onClose={onClose}
      title={title}
      onSubmit={onFormSubmit}
      isPending={isPending}
      submitLabel={submitLabel}
      submitDisabled={!selectedProvider}
      formProps={{ noValidate: true }}
      secondaryActions={
        <div className="mr-auto flex items-center gap-2">
          <PendingButton
            type="button"
            variant="outline"
            onClick={handleTest}
            pending={testMutation.isPending}
            disabled={!canTest}
          >
            {t("credentials.test")}
          </PendingButton>
          {testResult && (
            <TestResultSpan
              result={testResult}
              successKey="credentials.testSuccess"
              failedKey="credentials.testFailed"
            />
          )}
        </div>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="pk-provider">{t("credentials.form.provider")}</Label>
        {providerPicker}
        {/* The organization's form: a member's own subscription is connected elsewhere. */}
        {!personal && !isEditing && (
          <p className="text-muted-foreground text-sm">
            {t("credentials.form.subscriptionNote")}{" "}
            <PreferencesModelsLink>
              {t("credentials.form.subscriptionNoteLink")}
            </PreferencesModelsLink>
          </p>
        )}
      </div>

      {!isEditing && labelField}

      {needsBaseUrlOverride ? (
        <EndpointFields
          idPrefix="pk"
          providers={overridableProviders}
          provider={selectedProvider}
          onApiTypeChange={handleApiTypeChange}
          // `apiShape` and `baseUrl` are pinned by `providerId` at create
          // time — delete and re-create to point the key elsewhere.
          providerLocked={isEditing}
          baseUrlProps={register("baseUrlOverride", { validate: baseUrlValidate })}
          baseUrlLocked={isEditing}
          baseUrlError={showError("baseUrlOverride") ? errors.baseUrlOverride?.message : undefined}
          apiKeyProps={register("apiKey", { validate: apiKeyValidate })}
          apiKeyError={showError("apiKey") ? errors.apiKey?.message : undefined}
          apiKeyHint={credential ? t("credentials.form.apiKeyHint") : undefined}
        />
      ) : (
        !!selectedProvider && (
          <FormItem
            id="pk-apiKey"
            label={t("credentials.form.apiKey")}
            hint={credential ? t("credentials.form.apiKeyHint") : undefined}
            error={showError("apiKey") ? errors.apiKey?.message : undefined}
          >
            <Input
              type="password"
              {...register("apiKey", { validate: apiKeyValidate })}
              placeholder={t("credentials.form.apiKeyPlaceholder")}
            />
          </FormItem>
        )
      )}
    </FormModal>
  );
}

function PickerOptionItem({
  option,
  t,
}: {
  option: PickerOption;
  t: (key: string) => string;
}): React.ReactNode {
  // Inline lookup: `react-hooks/static-components` flags PascalCase consts assigned from helper calls.
  const Icon = PROVIDER_ICONS[option.iconUrl];
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
