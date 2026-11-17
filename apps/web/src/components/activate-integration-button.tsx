// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import { useTranslation } from "react-i18next";
import { DisabledReasonTooltip } from "./disabled-reason-tooltip";
import { usePackageActivation } from "../hooks/use-library";

/** Switches a declared integration on in this space; dead, with the reason, for a caller the route would refuse. */
export function ActivateIntegrationButton({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "common"]);
  const { mayActivate, activate, pending } = usePackageActivation(packageId);
  return (
    <DisabledReasonTooltip
      reason={mayActivate ? null : t("library.cannotActivate", { ns: "common" })}
    >
      <PendingButton
        size="sm"
        variant="outline"
        pending={pending}
        disabled={!mayActivate}
        onClick={() => activate()}
        data-testid={`integration-activate-${packageId}`}
      >
        {t("detail.activate")}
      </PendingButton>
    </DisabledReasonTooltip>
  );
}
