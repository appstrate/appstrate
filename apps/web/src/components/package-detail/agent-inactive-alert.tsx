// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Alert, AlertTitle } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { usePackageActivation } from "../../hooks/use-library";
import { useOverviewMode } from "../../hooks/use-overview-mode";

/**
 * The agent is placed in the working space and switched OFF. The page renders in full around this
 * line: only the execution doors refuse a switched-off agent. The button shows only with the
 * `activation` grant from the library row (RBAC spec §3.6); otherwise the banner states the
 * blockage alone. Silent in « Tous les espaces »: the header names the spaces the agent runs in,
 * and Actions › « Activer dans… » asks the space.
 */
export function AgentInactiveAlert({ packageId }: { packageId: string }) {
  const { t } = useTranslation("agents");
  const { on: overview } = useOverviewMode();
  const { mayActivate, activate, pending } = usePackageActivation(packageId);

  if (overview) return null;

  return (
    <Alert
      variant="destructive"
      className="mb-4"
      action={
        mayActivate && (
          <Button size="sm" disabled={pending} onClick={() => activate()}>
            {t("detail.activate")}
          </Button>
        )
      }
    >
      <AlertTitle>{t("detail.deactivatedHere")}</AlertTitle>
    </Alert>
  );
}
