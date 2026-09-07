// SPDX-License-Identifier: Apache-2.0

/**
 * The endpoint an operator supplies themselves: which API shape it speaks,
 * where it lives, and the key that opens it. Shared by the two forms that
 * configure one — the model form and the credential form — so the arrangement
 * has a single implementation.
 *
 * Which registry entries are offered is the host's business: it passes the
 * `baseUrlOverridable` ones, and the payload it builds names one of them.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { UseFormRegisterReturn } from "react-hook-form";
import { KeyRound, X } from "lucide-react";
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

/**
 * "Type a new key, or pick one you already saved." The row alone — the label,
 * the hint and the pinned-selection state belong to the host arrangement.
 */
export function ApiKeyRow({
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

/**
 * The credential a form is currently bound to, and the way to unbind it.
 * `icon` and `secondary` carry what a connection shows over a bare key.
 */
export function CredentialChip({
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

/**
 * Where the endpoint lives. `placeholder` is the picked entry's default URL, so
 * the shape it suggests is the one that entry's API actually answers on.
 */
export function BaseUrlField({
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
  providers,
  providerId,
  onApiTypeChange,
  providerLocked,
  baseUrlProps,
  baseUrlLocked,
  baseUrlError,
  apiKeyProps,
  apiKeyError,
  apiKeyHint,
  existingKeys,
}: {
  /** Namespaces the field ids so two forms can render this on one page. */
  idPrefix: string;
  providers: readonly ProviderRegistryEntry[];
  providerId: string;
  /**
   * The API type is the wire format, not the secret: the host points its base
   * URL at `entry.defaultBaseUrl` and keeps the typed key, dropping only a
   * saved credential, which pins both.
   */
  onApiTypeChange: (entry: ProviderRegistryEntry) => void;
  providerLocked?: boolean;
  baseUrlProps: UseFormRegisterReturn;
  baseUrlLocked: boolean;
  baseUrlError?: string;
  apiKeyProps: UseFormRegisterReturn;
  apiKeyError?: string;
  apiKeyHint?: string;
  existingKeys?: ExistingKeys;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const selectedKey = existingKeys?.selected ?? null;
  const selectedEntry = providers.find((p) => p.providerId === providerId);

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-apiType`}>{t("models.form.apiType")}</Label>
        <Select
          value={providerId}
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
        placeholder={selectedEntry?.defaultBaseUrl}
      />

      <div className="space-y-2">
        <Label htmlFor={selectedKey ? undefined : `${idPrefix}-apiKey`}>
          {t("credentials.form.apiKey")}
        </Label>
        {selectedKey && existingKeys ? (
          <CredentialChip label={selectedKey.label} onClear={existingKeys.onClear} />
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
