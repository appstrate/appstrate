// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useOrg } from "./use-org";
import { useSpaces } from "./use-spaces";
import { useCurrentSpaceId } from "./use-current-space";
import { useOverviewMode } from "./use-overview-mode";
import { spaceLabel } from "../lib/space-label";

/**
 * Where the user stands: the working space (null in « Tous les espaces », `overview`), the
 * context's label (the space, or « Tous les espaces »), and « Organization, context » as a screen
 * reader says it. The switcher and the shell's sidebar opener read them.
 */
export function useContextNames() {
  const { t } = useTranslation();
  const { currentOrg } = useOrg();
  const { data: spaces } = useSpaces();
  const currentSpaceId = useCurrentSpaceId();
  const overview = useOverviewMode();
  const currentSpace = overview.on ? null : (spaces?.find((s) => s.id === currentSpaceId) ?? null);
  const contextLabel = overview.on
    ? t("overview.title")
    : currentSpace
      ? spaceLabel(currentSpace, t)
      : undefined;
  return {
    currentSpace,
    overview: overview.on,
    contextLabel,
    names: [currentOrg?.name, contextLabel].filter(Boolean).join(", "),
  };
}
