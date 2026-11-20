// SPDX-License-Identifier: Apache-2.0

/**
 * The integration header's « Activer », the page's one place for it. With a space selected it
 * shows while the integration is off there, held back with the reason when the reader may not
 * switch it on. In « Tous les espaces » it is the placement deed (`usePlacementDeeds`): one
 * eligible space is one click naming it, several open their menu, none hides it.
 */

import { HeaderActionButton } from "../header-action-button";
import { ActivateIntegrationButton } from "../activate-integration-button";
import { SpaceChoiceDropdown } from "../space-choice-menu";
import { usePlacementDeeds } from "../space-deed";
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
    <ActivateIntegrationButton packageId={packageId} variant="header" />
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
