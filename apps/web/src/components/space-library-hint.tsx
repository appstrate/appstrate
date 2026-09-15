// SPDX-License-Identifier: Apache-2.0

import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { usePermissions } from "../hooks/use-permissions";

/**
 * Where the rest of the space's packages are, said on the screen that does not
 * show them.
 *
 * An index answers "what can I run here", so it lists the ACTIVE set and
 * nothing else. Everything else that reached this space — an offer nobody took
 * up, a package deliberately switched off — is in the space library, the one
 * management view (RBAC spec §6.8). Without this line an empty index reads as
 * "nothing was ever placed here", which is the one thing it does not mean.
 *
 * The link is gated on the permission the route itself is gated on
 * (`spaces:read`), so it never sends a reader to a page that answers "no
 * access" — the same rule the org switcher's entry follows.
 */
export function SpaceLibraryHint() {
  const { t } = useTranslation("common");
  const { can } = usePermissions();
  if (!can("spaces:read")) return null;
  return (
    <Trans
      t={t}
      i18nKey="library.indexEmptyHint"
      components={{
        1: <Link to="/space/packages" className="text-primary hover:underline" />,
      }}
    />
  );
}
