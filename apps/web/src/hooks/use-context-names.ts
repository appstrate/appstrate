// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useOrg } from "./use-org";
import { useSpaces } from "./use-spaces";
import { useCurrentSpaceId } from "./use-current-space";
import { useOverviewMode } from "./use-overview-mode";
import { spaceLabel } from "../lib/space-label";

/** « Organization, space » as a screen reader says where the user stands (the working context). */
export function useContextNames(): string {
  const { t } = useTranslation();
  const { currentOrg } = useOrg();
  const { data: spaces } = useSpaces();
  const currentSpaceId = useCurrentSpaceId();
  const overview = useOverviewMode();
  const currentSpace = spaces?.find((s) => s.id === currentSpaceId) ?? null;
  const context = overview.on
    ? t("overview.title")
    : currentSpace
      ? spaceLabel(currentSpace, t)
      : undefined;
  return [currentOrg?.name, context].filter(Boolean).join(", ");
}
