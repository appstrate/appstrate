// SPDX-License-Identifier: Apache-2.0

/** The oauth2 half of the endpoint block: an existing connection, or the pairing dialog. */

import { useTranslation } from "react-i18next";
import { Plug } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import type { ModelProviderCredentialInfo } from "../../hooks/use-model-provider-credentials";

export function ConnectionRow({
  connections,
  providerName,
  invalid,
  onSelect,
  onConnect,
}: {
  connections: readonly ModelProviderCredentialInfo[];
  providerName: string;
  invalid: boolean;
  onSelect: (id: string) => void;
  onConnect: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <div className="flex flex-col gap-2">
      {/* Stacked: a long provider name overflows two columns. */}
      {connections.length > 0 && (
        <Select value="" onValueChange={onSelect}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("models.form.useExistingConnection")} />
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
          </SelectContent>
        </Select>
      )}
      <Button
        type="button"
        variant="outline"
        className={cn("w-full min-w-0 justify-start", invalid && "border-destructive")}
        onClick={onConnect}
      >
        <Plug className="mr-2 size-4 shrink-0" />
        <span className="truncate">
          {connections.length > 0
            ? t("models.form.connectAnother", { provider: providerName })
            : t("models.form.connectProvider", { provider: providerName })}
        </span>
      </Button>
      <div className="text-muted-foreground text-sm">{t("models.form.connectProviderHint")}</div>
    </div>
  );
}
