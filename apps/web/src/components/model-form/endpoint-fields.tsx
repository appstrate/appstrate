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

export function EndpointFields({
  idPrefix,
  providers,
  providerId,
  onProviderChange,
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
  onProviderChange: (id: string) => void;
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

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-apiType`}>{t("models.form.apiType")}</Label>
        <Select value={providerId} onValueChange={onProviderChange} disabled={providerLocked}>
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

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-baseUrl`}>{t("models.form.baseUrl")}</Label>
        <Input
          id={`${idPrefix}-baseUrl`}
          type="url"
          {...baseUrlProps}
          disabled={baseUrlLocked}
          placeholder="https://api.openai.com/v1"
          aria-invalid={baseUrlError ? true : undefined}
          className={cn(baseUrlError && "border-destructive")}
        />
        <div className="text-muted-foreground text-sm">
          {baseUrlLocked ? t("models.form.baseUrlPinnedHint") : t("models.form.baseUrlHint")}
        </div>
        {baseUrlError && <div className="text-destructive text-sm">{baseUrlError}</div>}
      </div>

      <div className="space-y-2">
        <Label htmlFor={selectedKey ? undefined : `${idPrefix}-apiKey`}>
          {t("credentials.form.apiKey")}
        </Label>
        {selectedKey && existingKeys ? (
          <div className="flex gap-2">
            <div className="border-input bg-muted flex h-9 flex-1 items-center gap-2 rounded-md border px-3 text-sm">
              <KeyRound className="text-muted-foreground size-3.5 shrink-0" />
              <span className="truncate">{selectedKey.label}</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={existingKeys.onClear}
            >
              <X className="size-4" />
              <span className="sr-only">{t("btn.cancel")}</span>
            </Button>
          </div>
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
