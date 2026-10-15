// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertTitle } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { usePackageActivation } from "../../hooks/use-library";

/**
 * The agent is placed in this space and switched OFF. The page renders in full around this line:
 * only the execution doors refuse a switched-off agent. The button shows only with the `activation`
 * grant from the library row (RBAC spec §3.6); otherwise the banner states the blockage alone.
 */
export function AgentInactiveAlert({ packageId }: { packageId: string }) {
  const { t } = useTranslation("agents");
  const { mayActivate, activate, pending } = usePackageActivation(packageId);

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTriangle className="size-4" />
      <div className="flex items-start justify-between gap-3">
        <AlertTitle>{t("detail.deactivatedHere")}</AlertTitle>
        {mayActivate && (
          <Button size="sm" className="-my-1.5" disabled={pending} onClick={() => activate()}>
            {t("detail.activate")}
          </Button>
        )}
      </div>
    </Alert>
  );
}
