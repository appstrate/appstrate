// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import { useTranslation } from "react-i18next";
import { DisabledReasonTooltip } from "./disabled-reason-tooltip";
import { HeaderActionButton } from "./header-action-button";
import { usePackageActivation } from "../hooks/use-library";
import { ACTIVATION_REFUSAL_KEY } from "../lib/catalogue-gates";

/**
 * Switches a declared integration on in this space; dead, with the reason, for a caller the route
 * would refuse. `variant`: a row's outline button (`inline`), or the detail header's filled one.
 */
export function ActivateIntegrationButton({
  packageId,
  variant = "inline",
  onActivated,
  enabled,
}: {
  packageId: string;
  variant?: "inline" | "header";
  /** Runs once the integration is switched on. */
  onActivated?: () => void;
  /** `false` reads only the cache (see `usePackageActivation`). */
  enabled?: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { mayActivate, refusal, loading, activate, pending } = usePackageActivation(packageId, {
    enabled,
  });
  const props = {
    pending: pending || loading,
    disabled: !mayActivate,
    onClick: () => activate({ onSuccess: onActivated }),
    children: t("detail.activate"),
  };
  return (
    <DisabledReasonTooltip
      reason={
        mayActivate || loading
          ? null
          : t(ACTIVATION_REFUSAL_KEY[refusal ?? "activate"], { ns: "common" })
      }
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
