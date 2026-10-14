// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue as a destination of its own.
 *
 * It belongs next to settings, at the bottom of the navigation: both are
 * organization-wide surfaces that float over whatever you were doing, and both
 * are reachable from anywhere rather than from one list's action menu. Opening
 * it from a list lands on that list's kind — the way a settings link can point
 * straight at one settings page.
 *
 * Its floor is the space's library read (`ROUTE_ACCESS`): a reader who may
 * activate nothing still reads what each space holds, and every control inside
 * is graded by what they may do.
 */
import { useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { OrgCatalogueModal } from "../components/org-catalogue-modal";
import {
  CATALOGUE_KINDS,
  isCatalogueKind,
  isCatalogueReading,
  type CatalogueReading,
} from "../lib/catalogue-link";
import { useCloseOverlay } from "../lib/modal-route";
import { searchOf } from "../lib/url-search";
import { useOverlayBreadcrumb } from "../hooks/use-overlay-breadcrumb";
import { OverlayUnavailable } from "../components/overlay-unavailable";

export function CataloguePage() {
  // Découvrir by default: it is the reading everybody needs — what exists,
  // and whether the space I am in runs it — while the matrix serves the
  // reader who manages several spaces.
  const { reading = "discover", type = CATALOGUE_KINDS[0] } = useParams();
  const location = useLocation();
  const close = useCloseOverlay();
  const { t } = useTranslation("common");
  useOverlayBreadcrumb([{ label: t("nav.catalogue") }]);

  // A reading or a kind the catalogue does not have is an address that does not exist.
  if (!isCatalogueReading(reading) || !isCatalogueKind(type)) return <OverlayUnavailable />;

  return (
    <OrgCatalogueModal
      reading={reading}
      type={type}
      hrefOf={(nextReading: CatalogueReading, nextType: PackageType) => {
        // The state filter speaks each reading's own words (here / elsewhere
        // against active / inactive), so it does not survive a change of
        // reading; the rest of the query does.
        const query = new URLSearchParams(location.search);
        if (nextReading !== reading) query.delete("state");
        return `/catalogue/${nextReading}/${nextType}${searchOf(query)}`;
      }}
      onClose={close}
    />
  );
}
