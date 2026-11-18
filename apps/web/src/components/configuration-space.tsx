// SPDX-License-Identifier: Apache-2.0

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { SpaceChoiceDropdown } from "./space-choice-menu";
import { SpaceNameOf } from "./space-name";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import type { SpaceEntry } from "../hooks/use-space-entry";
import { spaceLabel } from "../lib/space-label";

type TargetSpace = NonNullable<SpaceEntry["target"]>;

/**
 * The space a per-space section is shown from, in « Tous les espaces »: `label`, then the working
 * space when it is one of `spaceIds` (the header's tiles), with the menu (`choiceLabel`) of the
 * others `enter` offers, or the one other space at a click (`targetLabel`, « Configurer dans
 * {space} » by default); otherwise a button asking for one. Picking one enters it (`enter`, the
 * page's {@link SpaceEntry}), and the section redraws there.
 */
export function ConfigurationSpace({
  label,
  choiceLabel,
  targetLabel,
  spaceIds,
  enter,
}: {
  label: string;
  choiceLabel: string;
  targetLabel?: (space: TargetSpace) => string;
  spaceIds: readonly string[];
  enter: SpaceEntry;
}) {
  const { t } = useTranslation("agents");
  const labelId = useId();
  const workingSpaceId = useCurrentSpaceId();
  const named = !!workingSpaceId && spaceIds.includes(workingSpaceId);
  const choice = enter.choose(choiceLabel, () => undefined);
  // The one other space, entered at a click.
  const other = !choice && enter.target && enter.target.id !== workingSpaceId ? enter.target : null;
  const nameTarget =
    targetLabel ??
    ((space: TargetSpace) =>
      t("detail.configuration.spaceChoiceIn", { space: spaceLabel(space, t) }));

  return (
    <div className="mb-6 flex min-h-8 flex-wrap items-center gap-2 text-sm">
      <span id={labelId} className="text-muted-foreground">
        {label}
      </span>
      {choice ? (
        <SpaceChoiceDropdown choice={choice}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={enter.entering}
            aria-describedby={labelId}
          >
            {named ? <SpaceNameOf spaceId={workingSpaceId} /> : t("detail.configuration.pickSpace")}
            <ChevronsUpDown className="text-muted-foreground" aria-hidden />
          </Button>
        </SpaceChoiceDropdown>
      ) : (
        named && <SpaceNameOf spaceId={workingSpaceId} size="md" />
      )}
      {other && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={enter.entering}
          aria-describedby={labelId}
          onClick={() => enter.run(() => undefined)}
        >
          {nameTarget(other)}
        </Button>
      )}
    </div>
  );
}
