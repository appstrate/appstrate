// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useHereSpaceId } from "./use-overview-mode";
import { useSpaceLabelOf } from "./use-spaces";

/**
 * « Partagé depuis … » for a package listed in the current space whose home is another: the home's
 * name, or a generic line when the reader cannot see it. Nothing at home, for a system package,
 * off an index (`homeSpaceId` undefined, a catalogue row), or in « Tous les espaces », where
 * nothing is « here » and `PackageSpaces` names the spaces instead.
 */
export function useSharedFromText(
  homeSpaceId: string | null | undefined,
  system: boolean,
): string | null {
  const { t } = useTranslation("common");
  const current = useHereSpaceId();
  const labelOf = useSpaceLabelOf();
  if (system || homeSpaceId === undefined || !current || homeSpaceId === current) return null;
  if (homeSpaceId === null) return t("packageSpaces.sharedFromHidden");
  const space = labelOf(homeSpaceId);
  return space ? t("packageSpaces.sharedFrom", { space }) : null;
}
