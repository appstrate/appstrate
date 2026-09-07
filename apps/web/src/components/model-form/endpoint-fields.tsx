// SPDX-License-Identifier: Apache-2.0

/**
 * How a form reaches its provider: API type and base URL where
 * `baseUrlOverridable`, then a key to type or pick, or a connection, per
 * `authMode`. Shared by the model form and the credential form.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { UseFormRegisterReturn } from "react-hook-form";
import { KeyRound, Plug, X } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { getProviderIcon } from "../icons";
import { ConnectionRow } from "./connection-row";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials";

/** Keys already saved for this endpoint. Omitted where the form only creates one. */
interface ExistingKeys {
  items: readonly ModelProviderCredentialInfo[];
  selected: ModelProviderCredentialInfo | null;
  onSelect: (id: string) => void;
  onClear: () => void;
}

/** "Type a new key, or pick one you already saved." Label and hint belong to the host. */
function ApiKeyRow({
  id,
  apiKeyProps,
  invalid,
  existingKeys,
}: {
  id: string;
  apiKeyProps: UseFormRegisterReturn;
  invalid: boolean;
  existingKeys?: ExistingKeys;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const pickable = existingKeys?.items ?? [];

  return (
    <div className="flex gap-2">
      <Input
        id={id}
        type="password"
        {...apiKeyProps}
        placeholder="sk-..."
        className={cn("min-w-0 flex-1", invalid && "border-destructive")}
        aria-invalid={invalid ? true : undefined}
      />
      {existingKeys && pickable.length > 0 && (
        <Select value="" onValueChange={existingKeys.onSelect}>
          <SelectTrigger className="w-32 shrink-0">
            <SelectValue placeholder={t("models.form.useExistingKey")} />
          </SelectTrigger>
          <SelectContent>
            {pickable.map((k) => (
              <SelectItem key={k.id} value={k.id}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

/** The credential a form is bound to, and the way to unbind it. */
function CredentialChip({
  label,
  icon,
  secondary,
  onClear,
}: {
  label: string;
  icon?: ReactNode;
  secondary?: string | null;
  onClear: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <div className="flex gap-2">
      <div className="border-input bg-muted flex h-9 flex-1 items-center gap-2 rounded-md border px-3 text-sm">
        {icon ?? <KeyRound className="text-muted-foreground size-3.5 shrink-0" />}
        <span className="truncate">{label}</span>
        {secondary && <span className="text-muted-foreground truncate text-xs">({secondary})</span>}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-9 w-9 shrink-0"
        onClick={onClear}
      >
        <X className="size-4" />
        <span className="sr-only">{t("btn.cancel")}</span>
      </Button>
    </div>
  );
}

/** `placeholder` is the picked entry's default URL. */
function BaseUrlField({
  id,
  baseUrlProps,
  locked,
  error,
  placeholder,
}: {
  id: string;
  baseUrlProps: UseFormRegisterReturn;
  locked: boolean;
  error?: string;
  placeholder?: string;
}) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("models.form.baseUrl")}</Label>
      <Input
        id={id}
        type="url"
        {...baseUrlProps}
        disabled={locked}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={cn(error && "border-destructive")}
      />
      <div className="text-muted-foreground text-sm">
        {locked ? t("models.form.baseUrlPinnedHint") : t("models.form.baseUrlHint")}
      </div>
      {error && <div className="text-destructive text-sm">{error}</div>}
    </div>
  );
}

export function EndpointFields({
  idPrefix,
  provider,
  providers,
  onApiTypeChange,
  providerLocked,
  baseUrlProps,
  baseUrlLocked,
  baseUrlError,
  apiKeyProps,
  apiKeyError,
  apiKeyHint,
  existingKeys,
  onConnect,
}: {
  /** Namespaces the field ids so two forms can render this on one page. */
  idPrefix: string;
  /** The picked entry. Undefined until a provider is chosen: nothing renders. */
  provider: ProviderRegistryEntry | undefined;
  /** The overridable entries — the "API type" question's options. */
  providers: readonly ProviderRegistryEntry[];
  /** The host re-points its base URL and keeps the typed key; a saved credential is dropped. */
  onApiTypeChange: (entry: ProviderRegistryEntry) => void;
  providerLocked?: boolean;
  baseUrlProps: UseFormRegisterReturn;
  baseUrlLocked: boolean;
  baseUrlError?: string;
  apiKeyProps: UseFormRegisterReturn;
  apiKeyError?: string;
  apiKeyHint?: string;
  existingKeys?: ExistingKeys;
  /** Opens the pairing dialog. Required wherever an oauth2 entry is offered. */
  onConnect?: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const selectedKey = existingKeys?.selected ?? null;
  const isOauth = provider?.authMode === "oauth2";

  if (!provider) return null;

  return (
    <>
      {provider.baseUrlOverridable && (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-apiType`}>{t("models.form.apiType")}</Label>
            <Select
              value={provider.providerId}
              onValueChange={(id) => {
                const entry = providers.find((p) => p.providerId === id);
                if (entry) onApiTypeChange(entry);
              }}
              disabled={providerLocked}
            >
              <SelectTrigger id={`${idPrefix}-apiType`}>
                <SelectValue placeholder={t("models.form.providerPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => {
                  const Icon = getProviderIcon(p);
                  return (
                    <SelectItem key={p.providerId} value={p.providerId}>
                      <span className="flex items-center gap-2">
                        {Icon && <Icon className="size-4" />}
                        {p.displayName}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <BaseUrlField
            id={`${idPrefix}-baseUrl`}
            baseUrlProps={baseUrlProps}
            locked={baseUrlLocked}
            error={baseUrlError}
            placeholder={provider.defaultBaseUrl}
          />
        </>
      )}

      <div className="space-y-2">
        <Label htmlFor={selectedKey || isOauth ? undefined : `${idPrefix}-apiKey`}>
          {isOauth ? t("models.form.connectionLabel") : t("credentials.form.apiKey")}
        </Label>
        {selectedKey && existingKeys ? (
          <CredentialChip
            label={selectedKey.label}
            icon={
              isOauth ? <Plug className="text-muted-foreground size-3.5 shrink-0" /> : undefined
            }
            secondary={isOauth ? selectedKey.oauth_email : undefined}
            onClear={existingKeys.onClear}
          />
        ) : isOauth ? (
          <ConnectionRow
            connections={existingKeys?.items ?? []}
            providerName={provider.displayName}
            invalid={!!apiKeyError}
            onSelect={(id) => existingKeys?.onSelect(id)}
            onConnect={() => onConnect?.()}
          />
        ) : (
          <ApiKeyRow
            id={`${idPrefix}-apiKey`}
            apiKeyProps={apiKeyProps}
            invalid={!!apiKeyError}
            existingKeys={existingKeys}
          />
        )}
        {apiKeyHint && <div className="text-muted-foreground text-sm">{apiKeyHint}</div>}
        {apiKeyError && <div className="text-destructive text-sm">{apiKeyError}</div>}
      </div>
    </>
  );
}
