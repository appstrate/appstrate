// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { usePermissions, type GateablePermission } from "../hooks/use-permissions";
import { EmptyState, LoadingState } from "./page-states";

/**
 * Route-level permission gate for the settings surfaces: it refuses to MOUNT
 * the page, so its queries never fire a row of 403s behind a blank panel. Not a
 * security boundary — the server's guards are.
 *
 * A list of permissions opens the page if the caller holds any one of them,
 * exactly as the route does (the webhooks page spans two resources).
 */
export function RequirePermission({
  permission,
  children,
}: {
  permission: GateablePermission | GateablePermission[];
  children: ReactNode;
}) {
  const { can, ready } = usePermissions();
  const required = Array.isArray(permission) ? permission : [permission];

  // An unloaded permission set answers `false` for everything.
  if (!ready) return <LoadingState />;
  if (required.some((p) => can(p))) return <>{children}</>;

  return <NoAccessState />;
}

/** The "you do not have access to this" panel, shared by every gated route. */
function NoAccessState() {
  const { t } = useTranslation("common");
  return <EmptyState message={t("access.denied")} hint={t("access.deniedHint")} icon={Lock} />;
}
