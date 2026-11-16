// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useCurrentSpaceId } from "./use-current-space";
import { useSpaceLabelOf } from "./use-spaces";

/**
 * « Partagé depuis … » for a package listed in ONE space whose home is another: the home's
 * name, or a generic line when the reader cannot see it. Nothing at home, for a system package,
 * or off an index (`homeSpaceId` undefined, a catalogue row).
 */
export function useSharedFromText(
  homeSpaceId: string | null | undefined,
  system: boolean,
): string | null {
  const { t } = useTranslation("common");
  const current = useCurrentSpaceId();
  const labelOf = useSpaceLabelOf();
  if (system || homeSpaceId === undefined || !current || homeSpaceId === current) return null;
  if (homeSpaceId === null) return t("packageSpaces.sharedFromHidden");
  const space = labelOf(homeSpaceId);
  return space ? t("packageSpaces.sharedFrom", { space }) : null;
}
