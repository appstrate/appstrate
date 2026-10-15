// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue as an org-wide overlay destination, like settings. Its floor is
 * the space's library read (`ROUTE_ACCESS`); every control inside is graded by
 * what the reader may do.
 */
import { Navigate, useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { OrgCatalogueModal } from "../components/org-catalogue-modal";
import { catalogueHref, CATALOGUE_KINDS, isCatalogueKind } from "../lib/catalogue-link";
import { useOverlayBreadcrumb } from "../hooks/use-overlay-breadcrumb";
import { PanelUnavailable } from "../components/overlay-unavailable";

/** `/catalogue` lands on the first kind; query and entry state ride along. */
export function CatalogueIndexRedirect() {
  const { search, hash, state } = useLocation();
  return (
    <Navigate to={`${catalogueHref(CATALOGUE_KINDS[0])}${search}${hash}`} replace state={state} />
  );
}

export function CataloguePage() {
  const { type = "" } = useParams();
  const { t } = useTranslation("common");
  useOverlayBreadcrumb([{ label: t("nav.catalogue") }]);

  // A kind the catalogue does not have is an address that does not exist.
  if (!isCatalogueKind(type)) return <PanelUnavailable />;

  return <OrgCatalogueModal type={type} />;
}
