// SPDX-License-Identifier: Apache-2.0

/**
 * How the credential form reaches its provider: API type and base URL where
 * `baseUrlOverridable`, then the key to type.
 */

import { useTranslation } from "react-i18next";
import type { UseFormRegisterReturn } from "react-hook-form";
import { FormItem } from "@/components/app-ui/form-item";
import { Input } from "@appstrate/ui/components/input";
import { OptionSelect } from "@/components/app-ui/option-select";
import { getProviderIcon } from "../icons";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials";

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
}: {
  /** Namespaces the field ids so two forms can render this on one page. */
  idPrefix: string;
  /** The picked entry. Undefined until a provider is chosen: nothing renders. */
  provider: ProviderRegistryEntry | undefined;
  /** The overridable entries — the "API type" question's options. */
  providers: readonly ProviderRegistryEntry[];
  /** The host re-points its base URL and keeps the typed key. */
  onApiTypeChange: (entry: ProviderRegistryEntry) => void;
  providerLocked?: boolean;
  baseUrlProps: UseFormRegisterReturn;
  baseUrlLocked: boolean;
  baseUrlError?: string;
  apiKeyProps: UseFormRegisterReturn;
  apiKeyError?: string;
  apiKeyHint?: string;
}) {
  const { t } = useTranslation(["settings", "common"]);

  if (!provider) return null;

  return (
    <>
      {provider.baseUrlOverridable && (
        <>
          <FormItem id={`${idPrefix}-apiType`} label={t("models.form.apiType")}>
            <OptionSelect
              value={provider.providerId}
              onValueChange={(id) => {
                const entry = providers.find((p) => p.providerId === id);
                if (entry) onApiTypeChange(entry);
              }}
              disabled={providerLocked}
              placeholder={t("models.form.providerPlaceholder")}
              options={providers.map((p) => {
                const Icon = getProviderIcon(p);
                return {
                  value: p.providerId,
                  label: (
                    <span className="flex items-center gap-2">
                      {Icon && <Icon className="size-4" />}
                      {p.displayName}
                    </span>
                  ),
                };
              })}
            />
          </FormItem>

          <FormItem
            id={`${idPrefix}-baseUrl`}
            label={t("models.form.baseUrl")}
            hint={baseUrlLocked ? t("models.form.baseUrlPinnedHint") : t("models.form.baseUrlHint")}
            error={baseUrlError}
          >
            <Input
              type="url"
              {...baseUrlProps}
              disabled={baseUrlLocked}
              placeholder={provider.defaultBaseUrl}
            />
          </FormItem>
        </>
      )}

      <FormItem
        id={`${idPrefix}-apiKey`}
        label={t("credentials.form.apiKey")}
        hint={apiKeyHint}
        error={apiKeyError}
      >
        <Input
          type="password"
          {...apiKeyProps}
          placeholder={t("credentials.form.apiKeyPlaceholder")}
        />
      </FormItem>
    </>
  );
}
