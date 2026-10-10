// SPDX-License-Identifier: Apache-2.0

/**
 * The oauth2 half of the endpoint block: the connections the form may bind and
 * the "each member" choice.
 */

import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import type { ModelProviderCredentialInfo } from "../../hooks/use-model-provider-credentials";

/** The picker item for "each member" — a UI token, never sent on the wire. */
export const EACH_MEMBER_ITEM = "__each_member__";

export function ConnectionRow({
  connections,
  invalid,
  eachMember,
  onSelect,
}: {
  connections: readonly ModelProviderCredentialInfo[];
  invalid: boolean;
  /** Offered where the model may be left to each member's own connection. */
  eachMember?: { onSelect: () => void };
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const offersPicker = connections.length > 0 || !!eachMember;

  return (
    <div className="flex flex-col gap-2">
      {/* Stacked: a long provider name overflows two columns. */}
      {offersPicker && (
        <Select
          value=""
          onValueChange={(id) => (id === EACH_MEMBER_ITEM ? eachMember?.onSelect() : onSelect(id))}
        >
          <SelectTrigger className={cn("w-full", invalid && "border-destructive")}>
            <SelectValue
              placeholder={
                connections.length > 0
                  ? t("models.form.useExistingConnection")
                  : t("models.form.chooseIdentity")
              }
            />
          </SelectTrigger>
          <SelectContent>
            {connections.map((k) => (
              <SelectItem key={k.id} value={k.id}>
                <span className="flex items-center gap-2">
                  <span className="truncate">{k.label}</span>
                  {k.oauth_email && (
                    <span className="text-muted-foreground truncate text-xs">{k.oauth_email}</span>
                  )}
                </span>
              </SelectItem>
            ))}
            {eachMember && (
              <SelectItem value={EACH_MEMBER_ITEM}>{t("models.form.eachMember")}</SelectItem>
            )}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
