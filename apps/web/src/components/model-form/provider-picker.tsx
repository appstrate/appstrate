// SPDX-License-Identifier: Apache-2.0

/**
 * Which provider a credential is for. The overridable entries collapse into one
 * "custom endpoint" row (the "API type" question picks among them), so the
 * shown value is not always the `providerId` the form holds.
 */

import { useTranslation } from "react-i18next";
import { Server } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { getProviderIcon } from "../icons";
import {
  buildProviderPickerRows,
  CUSTOM_ENDPOINT_ID,
  getProviderById,
  pickedProviderId,
} from "@/lib/provider-registry-helpers";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials";

export function ProviderPicker({
  id,
  registry,
  providerId,
  disabled,
  onChange,
  "aria-describedby": describedBy,
}: {
  id?: string;
  "aria-describedby"?: string;
  /** The entries on offer. */
  registry: readonly ProviderRegistryEntry[];
  providerId: string;
  disabled: boolean;
  onChange: (providerId: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const overridable = getProviderById(providerId, registry)?.baseUrlOverridable === true;

  const rows = buildProviderPickerRows(registry);

  const renderRow = (row: (typeof rows)[number]) => {
    if (row.kind === "customEndpoint") {
      return (
        <SelectItem key={CUSTOM_ENDPOINT_ID} value={CUSTOM_ENDPOINT_ID}>
          <span className="flex items-center gap-2">
            <Server className="size-4" />
            {t("models.form.customEndpoint")}
          </span>
        </SelectItem>
      );
    }
    const Icon = getProviderIcon(row.entry);
    return (
      <SelectItem key={row.entry.providerId} value={row.entry.providerId}>
        <span className="flex items-center gap-2">
          {Icon && <Icon className="size-4" />}
          {row.entry.displayName}
          {row.entry.authMode === "oauth2" && (
            <span className="text-muted-foreground ml-1 text-[0.7rem] uppercase">
              {t("credentials.oauth.badgeOauth")}
            </span>
          )}
        </span>
      </SelectItem>
    );
  };

  const group = (items: typeof rows, label: string) =>
    items.length > 0 && (
      <SelectGroup>
        <SelectLabel>{label}</SelectLabel>
        {items.map(renderRow)}
      </SelectGroup>
    );

  return (
    <Select
      value={overridable ? CUSTOM_ENDPOINT_ID : providerId}
      disabled={disabled}
      onValueChange={(picked) => onChange(pickedProviderId(picked, registry))}
    >
      <SelectTrigger id={id} aria-describedby={describedBy}>
        <SelectValue placeholder={t("models.form.providerPlaceholder")} />
      </SelectTrigger>
      <SelectContent>
        {group(
          rows.filter((row) => row.featured),
          t("models.form.modelGroupFeatured"),
        )}
        {group(
          rows.filter((row) => !row.featured),
          t("models.form.providerGroupOther"),
        )}
      </SelectContent>
    </Select>
  );
}
