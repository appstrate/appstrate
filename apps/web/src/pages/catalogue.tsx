// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue as a destination of its own.
 *
 * It belongs next to settings, at the bottom of the navigation: both are
 * organisation-wide surfaces that float over whatever you were doing, and both
 * are reachable from anywhere rather than from one list's action menu. Opening
 * it from a list still works and still lands on that list's kind — the way a
 * settings link can point straight at one settings page.
 */
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import type { PackageType } from "@appstrate/core/validation";
import { OrgCatalogueModal, type CatalogueScope } from "../components/org-catalogue-modal";
import { modalReturnTarget, useBackgroundLocation } from "../lib/modal-route";
import { useCatalogueKinds } from "../hooks/use-catalogue-kinds";

export function CataloguePage() {
  const { origin: scope, type } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const background = useBackgroundLocation();
  const kinds = useCatalogueKinds();

  // Nothing to activate anywhere: the entry is hidden, and a pasted link leaves.
  if (kinds.length === 0) return <Navigate to="/" replace />;

  const close = () => {
    const target = modalReturnTarget(background);
    navigate(target.to, { replace: true, state: target.state });
  };

  return (
    <OrgCatalogueModal
      // Découvrir by default: it is the reading everybody needs — what exists,
      // and whether the space I am in runs it — while the matrix serves the
      // reader who manages several spaces.
      scope={scope ?? "discover"}
      type={type ?? ""}
      onSelect={(nextScope: CatalogueScope, nextType: PackageType) => {
        // The state filter speaks each reading's own words (here / elsewhere
        // against active / inactive), so it does not survive a change of
        // reading; the rest of the query does.
        const query = new URLSearchParams(location.search);
        if (nextScope !== (scope ?? "discover")) query.delete("state");
        const search = query.toString();
        navigate(`/catalogue/${nextScope}/${nextType}${search ? `?${search}` : ""}`, {
          replace: true,
          state: location.state,
        });
      }}
      onClose={close}
    />
  );
}
