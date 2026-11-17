// SPDX-License-Identifier: Apache-2.0

/**
 * The integration header's « Activer », the page's one place for it. With a space selected it
 * shows while the integration is off there, held back with the reason when the reader may not
 * switch it on. In « Tous les espaces » it is the placement deed (`usePlacementDeeds`): one
 * eligible space is one click naming it, several open their menu, none hides it.
 */

import { useTranslation } from "react-i18next";
import { HeaderActionButton } from "../header-action-button";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";
import { SpaceChoiceDropdown } from "../space-choice-menu";
import { usePlacementDeeds } from "../space-deed";
import { usePackageActivation } from "../../hooks/use-library";
import { useOverviewMode } from "../../hooks/use-overview-mode";

export function IntegrationActivateButton({
  packageId,
  activeHere,
}: {
  packageId: string;
  /** Active in the working space. */
  activeHere: boolean;
}) {
  const { on } = useOverviewMode();
  return on ? (
    <ActivateAcross packageId={packageId} />
  ) : activeHere ? null : (
    <ActivateHere packageId={packageId} />
  );
}

function ActivateAcross({ packageId }: { packageId: string }) {
  const { activate } = usePlacementDeeds(packageId);
  if (!activate.offered) return null;
  return (
    <SpaceChoiceDropdown choice={activate.inSpaces}>
      <HeaderActionButton
        primary
        disabled={activate.disabled}
        onClick={activate.inSpaces ? undefined : activate.onSelect}
        data-testid="detail-activate-btn"
      >
        {activate.label}
      </HeaderActionButton>
    </SpaceChoiceDropdown>
  );
}

function ActivateHere({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const activation = usePackageActivation(packageId);
  return (
    <DisabledReasonTooltip
      reason={activation.mayActivate ? null : t("library.cannotActivate", { ns: "common" })}
    >
      <HeaderActionButton
        primary
        onClick={() => activation.activate()}
        disabled={activation.pending || !activation.mayActivate}
        data-testid="detail-activate-btn"
      >
        {t("integrations.btn.activate")}
      </HeaderActionButton>
    </DisabledReasonTooltip>
  );
}
