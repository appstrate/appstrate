// SPDX-License-Identifier: Apache-2.0

/**
 * The space an integration's per-space tab is shown from, in « Tous les espaces »: its
 * connections and its configuration (authentication, access) are a space's. The line names the
 * working space when the integration is active there, with the menu of its other spaces that
 * grant `permission`; picking one enters it, the integration already read there, so every read
 * and write below is that space's.
 */

import { useTranslation } from "react-i18next";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { SpaceChoiceDropdown } from "../space-choice-menu";
import { SpaceNameOf } from "../space-name";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useIntegrationSpaceAction } from "./use-integration-space";

export function IntegrationSpaceSelector({
  packageId,
  spaceIds,
  permission,
  label,
  choiceLabel,
}: {
  packageId: string;
  /** The spaces the integration is active in. */
  spaceIds: readonly string[];
  permission: string;
  /** What the line says before the space (« Configuration de l'espace »). */
  label: string;
  /** The menu's label (« Configurer dans… »). */
  choiceLabel: string;
}) {
  const { t } = useTranslation("agents");
  const workingSpaceId = useCurrentSpaceId();
  const enter = useIntegrationSpaceAction(packageId, permission, spaceIds);
  const named = !!workingSpaceId && spaceIds.includes(workingSpaceId);
  // Entering is all the pick does: the page redraws in the space entered.
  const choice = enter.choose(choiceLabel, () => undefined);
  // A space to go to: a menu between several, the one other space at a click.
  const elsewhere = enter.target ? enter.target.id !== workingSpaceId : !!choice;

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 text-sm" data-integration-space>
      <span className="text-muted-foreground">{label}</span>
      {elsewhere ? (
        <SpaceChoiceDropdown choice={choice}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={enter.entering}
            onClick={choice ? undefined : () => enter.run(() => undefined)}
          >
            {named ? <SpaceNameOf spaceId={workingSpaceId} /> : t("detail.configuration.pickSpace")}
            <ChevronsUpDown className="text-muted-foreground" aria-hidden />
          </Button>
        </SpaceChoiceDropdown>
      ) : named ? (
        <SpaceNameOf spaceId={workingSpaceId} size="md" />
      ) : null}
    </div>
  );
}
