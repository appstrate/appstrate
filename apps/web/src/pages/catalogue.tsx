// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue as a destination of its own.
 *
 * It belongs next to settings, at the bottom of the navigation: both are
 * organisation-wide surfaces that float over whatever you were doing, and both
 * are reachable from anywhere rather than from one list's action menu. Opening
 * it from a list lands on that list's kind — the way a settings link can point
 * straight at one settings page.
 *
 * Its floor is the space's library read (`ROUTE_ACCESS`): a reader who may
 * activate nothing still reads what each space holds, and every control inside
 * is graded by what they may do.
 */
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { OrgCatalogueModal } from "../components/org-catalogue-modal";
import {
  CATALOGUE_KINDS,
  isCatalogueKind,
  isCatalogueReading,
  type CatalogueReading,
} from "../lib/catalogue-link";
import { modalReturnTarget, useBackgroundLocation } from "../lib/modal-route";
import { useOverlayBreadcrumb } from "../hooks/use-overlay-breadcrumb";
import { Dialog, DialogContent, DialogTitle } from "@appstrate/ui/components/dialog";
import { UnavailableState } from "../components/route-gate";

export function CataloguePage() {
  // Découvrir by default: it is the reading everybody needs — what exists,
  // and whether the space I am in runs it — while the matrix serves the
  // reader who manages several spaces.
  const { reading = "discover", type = CATALOGUE_KINDS[0] } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const background = useBackgroundLocation();
  const { t } = useTranslation("common");
  useOverlayBreadcrumb([{ label: t("nav.catalogue") }]);

  const close = () => {
    const target = modalReturnTarget(background);
    navigate(target.to, { replace: true, state: target.state });
  };

  // A reading or a kind the catalogue does not have is an address that does not exist.
  if (!isCatalogueReading(reading) || !isCatalogueKind(type)) {
    return (
      <Dialog open onOpenChange={(open) => !open && close()}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle className="sr-only">{t("access.unavailable")}</DialogTitle>
          <UnavailableState />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <OrgCatalogueModal
      reading={reading}
      type={type}
      onSelect={(nextReading: CatalogueReading, nextType: PackageType) => {
        // The state filter speaks each reading's own words (here / elsewhere
        // against active / inactive), so it does not survive a change of
        // reading; the rest of the query does.
        const query = new URLSearchParams(location.search);
        if (nextReading !== reading) query.delete("state");
        const search = query.toString();
        navigate(`/catalogue/${nextReading}/${nextType}${search ? `?${search}` : ""}`, {
          replace: true,
        });
      }}
      onClose={close}
    />
  );
}
