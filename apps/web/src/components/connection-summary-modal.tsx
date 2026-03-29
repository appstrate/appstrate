import { useTranslation } from "react-i18next";
import { Building2, User, AlertTriangle, CheckCircle2, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "./modal";
import { ProviderIcon } from "./provider-icon";
import { useProviders } from "../hooks/use-providers";
import type { ProviderStatus } from "@appstrate/shared-types";

interface ConnectionSummaryModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onConfigureConnections?: () => void;
  providers: ProviderStatus[];
  orgProfileName?: string | null;
  isPending?: boolean;
}

export function ConnectionSummaryModal({
  open,
  onClose,
  onConfirm,
  onConfigureConnections,
  providers,
  orgProfileName,
  isPending,
}: ConnectionSummaryModalProps) {
  const { t } = useTranslation(["flows", "settings", "common"]);
  const { data: providersData } = useProviders();

  const allReady = providers.every((p) => p.status === "connected");

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
          {allReady ? (
            <Button onClick={onConfirm} disabled={isPending}>
              {isPending ? "..." : t("run.confirm")}
            </Button>
          ) : (
            <Button onClick={onConfigureConnections}>{t("run.configureConnections")}</Button>
          )}
        </>
      }
    >
      <div className="space-y-1.5">
        {providers.map((svc) => {
          const providerMeta = providersData?.providers?.find((p) => p.id === svc.id);
          const displayName = providerMeta?.displayName ?? svc.name ?? svc.id;
          const iconUrl = providerMeta?.iconUrl;
          const isOrg = svc.source === "org_binding";
          const isConnected = svc.status === "connected";

          return (
            <div
              key={svc.id}
              className="flex items-center gap-2 py-2 px-3 rounded-md border border-border bg-muted/30"
            >
              <div className="flex items-center gap-2 min-w-0 shrink-0">
                {iconUrl ? (
                  <ProviderIcon src={iconUrl} className="size-4 shrink-0" />
                ) : (
                  <Plug className="size-3.5 text-muted-foreground shrink-0" />
                )}
                <span className="text-sm font-medium truncate">{displayName}</span>
              </div>

              <div className="flex-1" />

              {!isConnected ? (
                <span className="inline-flex items-center gap-1 text-xs text-destructive">
                  <AlertTriangle className="size-3" />
                  {t("run.notConnected")}
                </span>
              ) : isOrg ? (
                <span className="inline-flex items-center gap-1 text-xs text-primary">
                  <Building2 className="size-3" />
                  {orgProfileName ?? t("providers.connected", { ns: "settings" })}
                  {svc.profileOwnerName && svc.profileName && (
                    <span className="text-muted-foreground ml-1">
                      {svc.profileOwnerName} — {svc.profileName}
                    </span>
                  )}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <User className="size-3" />
                  {svc.profileOwnerName && svc.profileName
                    ? `${svc.profileOwnerName} — ${svc.profileName}`
                    : (svc.profileName ?? t("providers.connected", { ns: "settings" }))}
                </span>
              )}

              {isConnected && <CheckCircle2 className="size-3.5 text-success shrink-0" />}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
