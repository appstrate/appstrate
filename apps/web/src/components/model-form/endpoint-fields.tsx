// SPDX-License-Identifier: Apache-2.0

/**
 * How a form reaches its provider: API type and base URL where
 * `baseUrlOverridable`, then a key to type or pick — or, for a subscription
 * (`oauth2`), one to pick among those the organization connected. Either
 * arrangement may also offer "each member". Shared by the model form and the
 * credential form.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { UseFormRegisterReturn } from "react-hook-form";
import { KeyRound, Users, X } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { FieldError, FormItem } from "@appstrate/ui/components/field";
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

/** The picker item for "each member" — a UI token, never sent on the wire. */
const EACH_MEMBER_ITEM = "__each_member__";

/** Keys already saved for this endpoint. Omitted where the form only creates one. */
interface ExistingKeys {
  items: readonly ModelProviderCredentialInfo[];
  selected: ModelProviderCredentialInfo | null;
  onSelect: (id: string) => void;
  onClear: () => void;
}

/**
 * The "each member" choice: no organization credential is bound, and every
 * member's own credential for the provider serves the model.
 */
export interface EachMemberChoice {
  selected: boolean;
  onSelect: () => void;
  onClear: () => void;
}

/**
 * The saved credentials a form may bind, then "each member" where offered.
 * Nothing renders with neither.
 */
function CredentialPicker({
  existingKeys,
  eachMember,
  placeholder,
  className,
}: {
  existingKeys?: ExistingKeys;
  eachMember?: { onSelect: () => void };
  placeholder: string;
  className: string;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const pickable = existingKeys?.items ?? [];
  if (pickable.length === 0 && !eachMember) return null;

  return (
    <Select
      value=""
      onValueChange={(value) =>
        value === EACH_MEMBER_ITEM ? eachMember?.onSelect() : existingKeys?.onSelect(value)
      }
    >
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {pickable.map((k) => (
          <SelectItem key={k.id} value={k.id}>
            {k.label}
          </SelectItem>
        ))}
        {eachMember && (
          <SelectItem value={EACH_MEMBER_ITEM}>{t("models.form.eachMember")}</SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

/** "Type a new key, or pick one you already saved." Label and hint belong to the host. */
function ApiKeyRow({
  id,
  apiKeyProps,
  invalid,
  existingKeys,
  eachMember,
}: {
  id: string;
  apiKeyProps: UseFormRegisterReturn;
  invalid: boolean;
  existingKeys?: ExistingKeys;
  eachMember?: { onSelect: () => void };
}) {
  const { t } = useTranslation(["settings", "common"]);

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
      <CredentialPicker
        existingKeys={existingKeys}
        eachMember={eachMember}
        placeholder={
          existingKeys?.items.length
            ? t("models.form.useExistingKey")
            : t("models.form.chooseIdentity")
        }
        className="w-40 shrink-0"
      />
    </div>
  );
}

/** The credential a form is bound to, and the way to unbind it. */
function CredentialChip({
  label,
  icon,
  onClear,
}: {
  label: string;
  icon?: ReactNode;
  onClear: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <div className="flex gap-2">
      <div className="border-input bg-muted flex h-9 flex-1 items-center gap-2 rounded-md border px-3 text-sm">
        {icon ?? <KeyRound className="text-muted-foreground size-3.5 shrink-0" />}
        <span className="truncate">{label}</span>
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
    <FormItem
      id={id}
      label={t("models.form.baseUrl")}
      hint={locked ? t("models.form.baseUrlPinnedHint") : t("models.form.baseUrlHint")}
      error={error}
    >
      <Input type="url" {...baseUrlProps} disabled={locked} placeholder={placeholder} />
    </FormItem>
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
  eachMember,
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
  /** Offered where a member's own credential may serve the model. */
  eachMember?: EachMemberChoice;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const selectedKey = existingKeys?.selected ?? null;
  const isOauth = provider?.authMode === "oauth2";
  const bound = !!eachMember?.selected || (!!selectedKey && !!existingKeys);

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
        <Label htmlFor={bound || isOauth ? undefined : `${idPrefix}-apiKey`}>
          {isOauth ? t("models.form.identityLabel") : t("credentials.form.apiKey")}
        </Label>
        {eachMember?.selected ? (
          <CredentialChip
            label={t("models.form.eachMember")}
            icon={<Users className="text-muted-foreground size-3.5 shrink-0" />}
            onClear={eachMember.onClear}
          />
        ) : selectedKey && existingKeys ? (
          <CredentialChip label={selectedKey.label} onClear={existingKeys.onClear} />
        ) : isOauth ? (
          // A subscription is paired from the credentials page, never typed here.
          <CredentialPicker
            existingKeys={existingKeys}
            eachMember={eachMember}
            placeholder={t("models.form.chooseIdentity")}
            className={cn("w-full", apiKeyError && "border-destructive")}
          />
        ) : (
          <ApiKeyRow
            id={`${idPrefix}-apiKey`}
            apiKeyProps={apiKeyProps}
            invalid={!!apiKeyError}
            existingKeys={existingKeys}
            eachMember={eachMember}
          />
        )}
        {eachMember?.selected && (
          <div className="text-muted-foreground text-sm">{t("models.form.eachMemberHint")}</div>
        )}
        {apiKeyHint && <div className="text-muted-foreground text-sm">{apiKeyHint}</div>}
        <FieldError>{apiKeyError}</FieldError>
      </div>
    </>
  );
}
