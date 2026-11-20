// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import { useTranslation } from "react-i18next";
import { DisabledReasonTooltip } from "./disabled-reason-tooltip";
import { HeaderActionButton } from "./header-action-button";
import { usePackageActivation } from "../hooks/use-library";

/**
 * Switches a declared integration on in this space; dead, with the reason, for a caller the route
 * would refuse. `variant`: a row's outline button (`inline`), or the detail header's filled one.
 */
export function ActivateIntegrationButton({
  packageId,
  variant = "inline",
}: {
  packageId: string;
  variant?: "inline" | "header";
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { mayActivate, activate, pending } = usePackageActivation(packageId);
  const props = {
    pending,
    disabled: !mayActivate,
    onClick: () => activate(),
    children: t("detail.activate"),
  };
  return (
    <DisabledReasonTooltip
      reason={mayActivate ? null : t("library.cannotActivate", { ns: "common" })}
    >
      {variant === "header" ? (
        <HeaderActionButton primary data-testid="detail-activate-btn" {...props} />
      ) : (
        <PendingButton
          size="sm"
          variant="outline"
          data-testid={`integration-activate-${packageId}`}
          {...props}
        />
      )}
    </DisabledReasonTooltip>
  );
}
