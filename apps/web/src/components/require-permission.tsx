// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { usePermissions, type GateablePermission } from "../hooks/use-permissions";
import { EmptyState, LoadingState } from "./page-states";

/**
 * Route-level permission gate for the settings surfaces.
 *
 * Hiding a tab is not a gate: every settings page is also reachable by URL, and
 * a page mounted without its read permission fires its queries anyway — the
 * caller gets a row of 403s and a blank panel that says nothing. This refuses
 * to MOUNT the page, so the queries never run, and shows why instead.
 *
 * It is not a security boundary — the server's guards are. It is the difference
 * between "you cannot see this" and an empty screen.
 *
 * `permission` may be a list, for a page whose content spans two resources
 * (the webhooks page lists the org and space levels); holding any one of them
 * opens it, exactly as the route does.
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

  // An unloaded permission set answers `false` for everything; refusing on it
  // would flash a denial on every hard reload.
  if (!ready) return <LoadingState />;
  if (required.some((p) => can(p))) return <>{children}</>;

  return <NoAccessState />;
}

/** The "you do not have access to this" panel, shared by every gated route. */
function NoAccessState() {
  const { t } = useTranslation("common");
  return <EmptyState message={t("access.denied")} hint={t("access.deniedHint")} icon={Lock} />;
}
