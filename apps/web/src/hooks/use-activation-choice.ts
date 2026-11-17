// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useCatalogueLibrary, useSetPackageActive } from "./use-library";
import { useOverviewMode } from "./use-overview-mode";
import { useSpaces } from "./use-spaces";
import { activationGate } from "../lib/catalogue-gates";
import { spacesWhere } from "../lib/space-lists";
import type { SpaceChoiceMenu } from "../lib/menu-action";

/**
 * « Activer » in « Tous les espaces »: the spaces where the package is not active yet and the
 * reader may switch it on (the library's `activation` verdicts), to choose from. `undefined` out of
 * the mode, and when no space is left.
 */
export function useActivationChoice(
  type: "agent" | "skill" | "integration",
  packageId: string,
): SpaceChoiceMenu | undefined {
  const { t } = useTranslation("settings");
  const { on } = useOverviewMode();
  const { data: library } = useCatalogueLibrary({ enabled: on });
  const { data: spaces } = useSpaces();
  const setActive = useSetPackageActive();
  if (!on) return undefined;
  const row = library?.packages[type].find((pkg) => pkg.id === packageId);
  if (!row) return undefined;
  const eligible = spacesWhere(
    spaces,
    undefined,
    (_can, space) =>
      activationGate(row, space.id, true).allowed &&
      row.placements.find((placement) => placement.space_id === space.id)?.state !== "active",
  );
  if (eligible.length === 0) return undefined;
  return {
    label: t("integrations.btn.activateIn"),
    spaces: eligible,
    onPick: (spaceId) => setActive.mutate({ spaceId, packageId, active: true }),
  };
}
