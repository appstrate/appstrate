// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Lock, SearchX } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { usePermissions } from "../hooks/use-permissions";
import { useAppConfig } from "../hooks/use-app-config";
import { routeVerdict, type RoutePath } from "../lib/route-access";
import { routeOf } from "../lib/route-match";
import { EmptyState } from "./page-states";
import { PanelMessage } from "./panel-layout";

/**
 * Route-level gate, read off the route's declaration in `lib/route-access.ts`:
 * it refuses to MOUNT the page, so its queries never fire a row of 403s behind
 * a blank panel. Not a security boundary — the server's guards are. A route
 * that does not exist here (module not loaded, team-space page in a personal
 * space) says so, never a silent redirect. Asked of the page the URL lands on
 * too: a layout mounts before its child's gate.
 */
export function RouteGate({
  path,
  pending,
  inPanel = false,
  children,
}: {
  path: RoutePath;
  /** Drawn while the permissions load: the page's own skeleton. */
  pending: ReactNode;
  /** The route is a panel overlay's: a refusal is said inside the panel's box, in the width of its panes. */
  inPanel?: boolean;
  children: ReactNode;
}) {
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

  const said = (state: ReactNode) => (inPanel ? <PanelMessage>{state}</PanelMessage> : state);

  if (absent) {
    return said(<UnavailableState />);
  }
  if (verdict === "granted") return <>{children}</>;
  // An unloaded permission set answers `false` for everything.
  if (!ready) return <>{pending}</>;
  return said(<NoAccessState />);
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

/** "This page does not exist here": a typo, a module the instance does not load, a team-space page in a personal space. */
export function UnavailableState({ children }: { children?: ReactNode }) {
  const { t } = useTranslation("common");
  return (
    <EmptyState message={t("access.unavailable")} hint={t("access.unavailableHint")} icon={SearchX}>
      {children}
    </EmptyState>
  );
}

/** The address matches no route: said, with the way back, instead of landing on the dashboard unexplained. */
export function NotFoundPage() {
  const { t } = useTranslation("common");
  return (
    <UnavailableState>
      <Button asChild variant="outline" size="sm">
        <Link to="/">{t("nav.dashboard")}</Link>
      </Button>
    </UnavailableState>
  );
}
