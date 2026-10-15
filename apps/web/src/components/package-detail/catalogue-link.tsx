// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { Library } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { useCanReach } from "../../hooks/use-can-reach";
import { modalOpeningState } from "../../hooks/use-modal-param";
import { catalogueHref } from "../../lib/catalogue-link";
import { TOOLBAR_ACTION } from "../../lib/toolbar-button";

/**
 * A package page's way over to the package's sheet in the catalogue: where it
 * is placed, and what the reader may do about it. Pinned to `version` when the
 * page reads a published version the reader chose, so the sheet opens on that
 * version instead of the current one (`catalogueVersionFor`).
 *
 * Absent for a reader the catalogue's own gate would refuse: a link to a page
 * that answers "unavailable" is not worth drawing.
 */
export function CatalogueLink({
  type,
  packageId,
  version,
}: {
  type: PackageType;
  packageId: string;
  version?: string;
}) {
  const { t } = useTranslation("settings");
  const canReach = useCanReach();
  const location = useLocation();
  if (!canReach(catalogueHref(type))) return null;

  const label = version
    ? t("catalogue.openInCatalogueVersion", { version })
    : t("catalogue.openInCatalogue");
  return (
    // Square, icon only, where the label is dropped (`lg`): not the label's padding around a glyph.
    <Button
      asChild
      variant="outline"
      size="sm"
      className={cn(TOOLBAR_ACTION, "max-lg:w-8 max-lg:px-0")}
    >
      {/* Pushed as the sheet's own opening: closing it goes back to this page. */}
      <Link
        to={catalogueHref(type, { packageId, version })}
        state={modalOpeningState(location.state, "package")}
        aria-label={label}
        title={label}
      >
        <Library aria-hidden />
        <span className="hidden lg:inline">{t("catalogue.openInCatalogue")}</span>
      </Link>
    </Button>
  );
}
