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
      breadcrumb: t("nav.breadcrumb"),
      breadcrumbMore: t("nav.breadcrumbMore"),
      copy: t("btn.copy"),
      copied: t("btn.copied"),
      copyFailed: t("error.copyFailed"),
      moreInfo: t("btn.moreInfo"),
      integrations: t("integrationStack.title"),
      integrationsNamed: (names: string) => t("integrationStack.label", { names }),
      integrationInactive: (name: string) => t("integrationStack.inactive", { name }),
    }),
    [t],
  );
  return <UiLabelsContext.Provider value={labels}>{children}</UiLabelsContext.Provider>;
}
