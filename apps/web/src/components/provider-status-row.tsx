// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  Plug,
  Building2,
  User,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Shield,
} from "lucide-react";
import { ProviderIcon } from "./provider-icon";
import { isProviderStatusConnected } from "../lib/provider-status";

interface ProviderStatusRowProps {
  id: string;
  status: string;
  source: "app_binding" | "user_profile" | null;
  profileName: string | null;
  profileOwnerName: string | null;
  scopesSufficient?: boolean;
  displayName?: string;
  iconUrl?: string | null;
  appProfileName?: string | null;
}

export function ProviderStatusRow({
  status,
  source,
  profileName,
  profileOwnerName,
  scopesSufficient,
  displayName,
  iconUrl,
  appProfileName,
}: ProviderStatusRowProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const isAppBinding = source === "app_binding";
  const isConnected = isProviderStatusConnected(status);

  return (
    <div className="border-border bg-muted/30 flex items-center gap-2 rounded-md border px-3 py-2">
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        {iconUrl ? (
          <ProviderIcon src={iconUrl} className="size-4 shrink-0" />
        ) : (
          <Plug className="text-muted-foreground size-3.5 shrink-0" />
        )}
        <span className="truncate text-sm font-medium">{displayName}</span>
      </div>

      <div className="flex-1" />

      {!isConnected ? (
        <span className="text-destructive inline-flex items-center gap-1 text-xs">
          <AlertTriangle className="size-3" />
          {t("run.notConnected")}
        </span>
      ) : isAppBinding ? (
        <span className="text-primary inline-flex items-center gap-1 text-xs">
          <Building2 className="size-3" />
          {appProfileName ?? t("providers.connected", { ns: "settings" })}
          {profileOwnerName && profileName && (
            <span className="text-muted-foreground ml-1">
              {profileOwnerName} — {profileName}
            </span>
          )}
        </span>
      ) : (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
          <User className="size-3" />
          {profileOwnerName && profileName
            ? `${profileOwnerName} — ${profileName}`
            : (profileName ?? t("providers.connected", { ns: "settings" }))}
        </span>
      )}

      {isConnected && scopesSufficient === false ? (
        <span className="inline-flex items-center gap-1 text-xs text-amber-500">
          <Shield className="size-3.5 shrink-0" />
          {t("providerCard.scopesMissing")}
        </span>
      ) : isConnected && status === "needs_reconnection" ? (
        <AlertCircle className="size-3.5 shrink-0 text-amber-500" />
      ) : isConnected ? (
        <CheckCircle2 className="text-success size-3.5 shrink-0" />
      ) : null}
    </div>
  );
}
