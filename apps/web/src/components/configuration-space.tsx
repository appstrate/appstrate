// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { SpaceChoiceDropdown } from "./space-choice-menu";
import { SpaceNameOf } from "./space-name";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import type { SpaceEntry } from "../hooks/use-space-entry";

/**
 * The space a per-space section is shown from, in « Tous les espaces »: `label`, then the working
 * space when it is one of `spaceIds` (the header's tiles), with the menu (`choiceLabel`) of the
 * others `enter` offers; otherwise a button asking for one. Picking one enters it (`enter`, the
 * page's {@link SpaceEntry}), and the section redraws there.
 */
export function ConfigurationSpace({
  label,
  choiceLabel,
  spaceIds,
  enter,
}: {
  label: string;
  choiceLabel: string;
  spaceIds: readonly string[];
  enter: SpaceEntry;
}) {
  const { t } = useTranslation("agents");
  const workingSpaceId = useCurrentSpaceId();
  const named = !!workingSpaceId && spaceIds.includes(workingSpaceId);
  const choice = enter.choose(choiceLabel, () => undefined);
  // A space to go to: a menu between several, the one other space at a click.
  const elsewhere = enter.target ? enter.target.id !== workingSpaceId : !!choice;

  return (
    <div
      className="mb-6 flex min-h-8 flex-wrap items-center gap-2 text-sm"
      data-configuration-space
    >
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
