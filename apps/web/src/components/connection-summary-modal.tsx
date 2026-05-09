// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { Modal } from "./modal";
import { ProviderStatusRow } from "./provider-status-row";
import { useProviders } from "../hooks/use-providers";
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
  const { data: providerConfigs } = useProviders();

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
          const providerMeta = providerConfigs?.find((p) => p.id === svc.id);
          return (
            <ProviderStatusRow
              key={svc.id}
              id={svc.id}
              status={svc.status}
              source={svc.source}
              profileName={svc.profileName}
              profileOwnerName={svc.profileOwnerName}
              scopesSufficient={svc.scopesSufficient}
              displayName={providerMeta?.displayName ?? svc.id}
              iconUrl={providerMeta?.iconUrl}
              appProfileName={appProfileName}
            />
          );
        })}
      </div>
    </Modal>
  );
}
