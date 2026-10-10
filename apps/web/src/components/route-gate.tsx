// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { NavigateKeepingState } from "./navigate-keeping-state";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { useAppConfig } from "../hooks/use-app-config";
import { routeVerdict, type RoutePath } from "../lib/route-access";
import { routeOf } from "../lib/route-match";
import { EmptyState, LoadingState } from "./page-states";
import { ViewAsBanner } from "./view-as-banner";

/**
 * Route-level gate, read off the route's declaration in `lib/route-access.ts`:
 * it refuses to MOUNT the page, so its queries never fire a row of 403s behind
 * a blank panel. Not a security boundary — the server's guards are. A route
 * that does not exist here (module not loaded, team-space page in a personal
 * space) falls back to the workspace's settings or the dashboard. Asked of the
 * page the URL lands on too: a layout mounts before its child's gate.
 */
export function RouteGate({ path, children }: { path: RoutePath; children: ReactNode }) {
  const { can, ready, inPersonalSpace } = usePermissions();
  const { features } = useAppConfig();
  const verdict = routeVerdict(path, can, features, inPersonalSpace);
  const landing = routeOf(useLocation().pathname) ?? path;
  const absent =
    verdict === "absent"
      ? path
      : routeVerdict(landing, can, features, inPersonalSpace) === "absent"
        ? landing
        : null;

  if (absent) {
    // A workspace settings page falls back to the rail's first entry, inside
    // the same overlay (its index picks it, and the state keeps the overlay).
    return absent.startsWith("/workspace-settings/") ? (
      <NavigateKeepingState to="/workspace-settings" />
    ) : (
      <Navigate to="/" replace />
    );
  }
  if (verdict === "granted") return <>{children}</>;
  // An unloaded permission set answers `false` for everything.
  if (!ready) return <LoadingState />;
  // The chat is mounted beside Studio, not inside it: a refusal there has no
  // shell around it, so a preview would show no banner and no way out.
  return path.startsWith("/chat") ? (
    <>
      <ViewAsBanner />
      <NoAccessState />
    </>
  ) : (
    <NoAccessState />
  );
}

/**
 * The "you do not have access to this" panel, shared by every gated route —
 * and by the package editor, which is NOT gated on the current space (write
 * authority is the package's home) and so renders it from `home_writable` once
 * the detail has loaded.
 */
export function NoAccessState() {
  const { t } = useTranslation("common");
  return <EmptyState message={t("access.denied")} hint={t("access.deniedHint")} icon={Lock} />;
}
