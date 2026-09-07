// SPDX-License-Identifier: Apache-2.0

/**
 * Which provider a model runs on. The overridable entries collapse into one
 * "custom endpoint" row (the "API type" question picks among them), so the
 * shown value is not always the `providerId` the form holds.
 */

import { useTranslation } from "react-i18next";
import { Server } from "lucide-react";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { ProviderPickerGroups } from "../provider-picker-groups";
import { getProviderIcon } from "../icons";
import {
  buildProviderPickerRows,
  CUSTOM_ENDPOINT_ID,
  getProviderById,
  pickedProviderId,
} from "@/lib/provider-registry-helpers";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials";

/** The one row every `baseUrlOverridable` entry collapses into. */
export function CustomEndpointItem() {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <SelectItem value={CUSTOM_ENDPOINT_ID}>
      <span className="flex items-center gap-2">
        <Server className="size-4" />
        {t("models.form.customEndpoint")}
      </span>
    </SelectItem>
  );
}

export function ProviderPicker({
  id,
  registry,
  providerId,
  disabled,
  onChange,
}: {
  id: string;
  registry: readonly ProviderRegistryEntry[];
  providerId: string;
  disabled: boolean;
  onChange: (providerId: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const overridable = getProviderById(providerId, registry)?.baseUrlOverridable === true;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("models.form.provider")}</Label>
      <Select
        value={overridable ? CUSTOM_ENDPOINT_ID : providerId}
        disabled={disabled}
        onValueChange={(picked) => onChange(pickedProviderId(picked, registry))}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={t("models.form.providerPlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          <ProviderPickerGroups
            items={buildProviderPickerRows(registry)}
            featuredLabel={t("models.form.providerGroupFeatured")}
            otherLabel={t("models.form.providerGroupOther")}
            renderItem={(row) => {
              if (row.kind === "customEndpoint") {
                return <CustomEndpointItem key={CUSTOM_ENDPOINT_ID} />;
              }
              const Icon = getProviderIcon(row.entry);
              return (
                <SelectItem key={row.entry.providerId} value={row.entry.providerId}>
                  <span className="flex items-center gap-2">
                    {Icon && <Icon className="size-4" />}
                    {row.entry.displayName}
                  </span>
                </SelectItem>
              );
            }}
          />
        </SelectContent>
      </Select>
    </div>
  );
}
