// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  Building2,
  User,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Plug,
  Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { Modal } from "./modal";
import { ProviderIcon } from "./provider-icon";
import { useProviders } from "../hooks/use-providers";
import { isProviderStatusConnected } from "../lib/provider-status";
import type { ProviderStatus } from "@appstrate/shared-types";

interface ConnectionSummaryModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onConfigureConnections: () => void;
  providers: ProviderStatus[];
  appProfileName?: string | null;
  isPending?: boolean;
}

export function ConnectionSummaryModal({
  open,
  onClose,
  onConfirm,
  onConfigureConnections,
  providers,
  appProfileName,
  isPending,
}: ConnectionSummaryModalProps) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const { data: providersData } = useProviders();

  const allReady = providers.every((p) => p.status === "connected" && p.scopesSufficient !== false);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("run.confirmTitle")}
      actions={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          <Button variant="outline" onClick={onConfigureConnections}>
            {t("run.configureConnections")}
          </Button>
          {allReady && (
            <Button onClick={onConfirm} disabled={isPending}>
              {isPending ? <Spinner /> : t("run.confirm")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-1.5">
        {providers.map((svc) => {
          const providerMeta = providersData?.providers?.find((p) => p.id === svc.id);
          const displayName = providerMeta?.displayName ?? svc.id;
          const iconUrl = providerMeta?.iconUrl;
          const isAppBinding = svc.source === "app_binding";
          const isConnected = isProviderStatusConnected(svc.status);

          return (
            <div
              key={svc.id}
              className="border-border bg-muted/30 flex items-center gap-2 rounded-md border px-3 py-2"
            >
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
                  {svc.profileOwnerName && svc.profileName && (
                    <span className="text-muted-foreground ml-1">
                      {svc.profileOwnerName} — {svc.profileName}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                  <User className="size-3" />
                  {svc.profileOwnerName && svc.profileName
                    ? `${svc.profileOwnerName} — ${svc.profileName}`
                    : (svc.profileName ?? t("providers.connected", { ns: "settings" }))}
                </span>
              )}

              {isConnected && svc.scopesSufficient === false ? (
                <span className="inline-flex items-center gap-1 text-xs text-amber-500">
                  <Shield className="size-3.5 shrink-0" />
                  {t("providerCard.scopesMissing")}
                </span>
              ) : isConnected && svc.status === "needs_reconnection" ? (
                <AlertCircle className="size-3.5 shrink-0 text-amber-500" />
              ) : isConnected ? (
                <CheckCircle2 className="text-success size-3.5 shrink-0" />
              ) : null}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
