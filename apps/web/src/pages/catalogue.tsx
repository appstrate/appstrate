// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue as an org-wide overlay destination, like settings. Its floor is
 * the space's library read (`ROUTE_ACCESS`); every control inside is graded by
 * what the reader may do.
 */
import { Navigate, useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { OrgCatalogueModal } from "../components/org-catalogue-modal";
import {
  catalogueHref,
  CATALOGUE_KINDS,
  CATALOGUE_PACKAGE_PARAM,
  CATALOGUE_VERSION_PARAM,
  isCatalogueKind,
  isCatalogueReading,
  type CatalogueReading,
} from "../lib/catalogue-link";
import { searchOf } from "../lib/url-search";
import { useOverlayBreadcrumb } from "../hooks/use-overlay-breadcrumb";
import { PanelUnavailable } from "../components/overlay-unavailable";

/** `/catalogue` lands on the first kind of Découvrir; query and entry state ride along. */
export function CatalogueIndexRedirect() {
  const { search, hash, state } = useLocation();
  return (
    <Navigate to={`${catalogueHref(CATALOGUE_KINDS[0])}${search}${hash}`} replace state={state} />
  );
}

export function CataloguePage() {
  const { reading = "", type = "" } = useParams();
  const location = useLocation();
  const { t } = useTranslation("common");
  useOverlayBreadcrumb([{ label: t("nav.catalogue") }]);

  // A reading or a kind the catalogue does not have is an address that does not exist.
  if (!isCatalogueReading(reading) || !isCatalogueKind(type)) return <PanelUnavailable />;

  return (
    <OrgCatalogueModal
      reading={reading}
      type={type}
      hrefOf={(nextReading: CatalogueReading, nextType: PackageType) => {
        // The state filter is reading-specific, so it is dropped on a reading change.
        const query = new URLSearchParams(location.search);
        query.delete(CATALOGUE_PACKAGE_PARAM);
        query.delete(CATALOGUE_VERSION_PARAM);
        if (nextReading !== reading) query.delete("state");
        return `/catalogue/${nextReading}/${nextType}${searchOf(query)}`;
      }}
    />
  );
}
