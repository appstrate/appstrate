// SPDX-License-Identifier: Apache-2.0

/**
 * A gateway configuration's endpoint: its API type and its base URL. A provider that pins its own
 * endpoint (`baseUrlOverridable: false`) asks nothing.
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
  baseUrlError,
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
  baseUrlError?: string;
}) {
  const { t } = useTranslation(["settings", "common"]);

  if (!provider?.baseUrlOverridable) return null;

  return (
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
        hint={t("models.form.baseUrlHint")}
        error={baseUrlError}
      >
        <Input type="url" {...baseUrlProps} placeholder={provider.defaultBaseUrl} />
      </FormItem>
    </>
  );
}
