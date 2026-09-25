// SPDX-License-Identifier: Apache-2.0

import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { PackageType } from "@appstrate/core/validation";
import { usePermissions } from "../hooks/use-permissions";
import { packagePermission } from "@appstrate/core/permissions";

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
 * Gated on the TYPE's own `read` in THIS space, which is the predicate the
 * library's contents are built from (`readableSpaceIds`,
 * `services/package-library.ts`) — not on the org-level `spaces:read` the route
 * merely mounts behind. The two are different questions, and a `runner` is
 * where they part: it holds `agents:run` and `spaces:read` but no
 * `agents:read`, so the page answers 200 with an empty list rather than a 403.
 * Gating on reachability alone therefore sent the one preset that can act on
 * NOTHING in that library — no activation, no deactivation, no configuration —
 * to a page that is empty for it by design.
 */
export function SpaceLibraryHint({ type }: { type: PackageType }) {
  const { t } = useTranslation("common");
  const { can } = usePermissions();
  if (!can(packagePermission(type, "read"))) return null;
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
