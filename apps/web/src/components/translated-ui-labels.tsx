// SPDX-License-Identifier: Apache-2.0

import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UiLabelsContext } from "@appstrate/ui/components/ui-labels";

/** Hands the design system the strings its own primitives render, in the active language. */
export function TranslatedUiLabels({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  const labels = useMemo(
    () => ({
      close: t("btn.close"),
      sidebar: t("nav.sidebar"),
      sidebarDescription: t("nav.sidebarDescription"),
      toggleSidebar: t("nav.toggleSidebar"),
    }),
    [t],
  );
  return <UiLabelsContext.Provider value={labels}>{children}</UiLabelsContext.Provider>;
}
