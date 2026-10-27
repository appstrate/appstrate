// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import type { PackageType } from "@appstrate/core/validation";
import { useCanReach } from "../../hooks/use-can-reach";
import { modalOpeningState } from "../../hooks/use-url-modal";
import { catalogueHref } from "../../lib/catalogue-link";

/**
 * A package page's way over to the package's sheet in the catalogue: where it
 * is placed, and what the reader may do about it. Pinned to `version` when the
 * page reads a published version the reader chose, so the sheet opens on that
 * version instead of the current one (`catalogueVersionFor`).
 *
 * `null` for a reader the catalogue's own gate would refuse: an entry leading to
 * a page that answers "unavailable" is not worth drawing. The destination is
 * pushed as the sheet's own opening, so closing it goes back to this page.
 */
export function useCatalogueEntry(type: PackageType, packageId: string, version?: string) {
  const { t } = useTranslation("settings");
  const canReach = useCanReach();
  const location = useLocation();
  if (!canReach(catalogueHref(type))) return null;
  return {
    to: catalogueHref(type, { packageId, version }),
    state: modalOpeningState(location.state, "package"),
    label: version
      ? t("catalogue.openInCatalogueVersion", { version })
      : t("catalogue.openInCatalogue"),
  };
}
