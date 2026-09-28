// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { usePermissions, useCanManageOrgCatalog } from "../hooks/use-permissions";
import { useAppConfig } from "../hooks/use-app-config";
import { routeVerdict, type RoutePath } from "../lib/route-access";
import { EmptyState, LoadingState } from "./page-states";

/**
 * Route-level gate, read off the route's declaration in `lib/route-access.ts`:
 * it refuses to MOUNT the page, so its queries never fire a row of 403s behind
 * a blank panel. Not a security boundary — the server's guards are. A route
 * whose module is not loaded does not exist, and falls back to the dashboard.
 */
export function RouteGate({ path, children }: { path: RoutePath; children: ReactNode }) {
  const { can, ready } = usePermissions();
  const { features } = useAppConfig();
  const verdict = routeVerdict(path, can, features);

  if (verdict === "absent") return <Navigate to="/" replace />;
  if (verdict === "granted") return <>{children}</>;
  // An unloaded permission set answers `false` for everything.
  return ready ? <NoAccessState /> : <LoadingState />;
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

/** The organization library is administrative even when the caller manages a space. */
export function RequireOrgCatalogAdmin({ children }: { children: ReactNode }) {
  const { ready } = usePermissions();
  const allowed = useCanManageOrgCatalog();
  if (!ready) return <LoadingState />;
  return allowed ? <>{children}</> : <NoAccessState />;
}
