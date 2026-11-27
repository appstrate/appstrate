// SPDX-License-Identifier: Apache-2.0

import { useEffect, useEffectEvent } from "react";
import { useLocation } from "react-router-dom";
import { DashboardSkeleton } from "../components/loading-skeletons";
import { NoAccessState } from "../components/route-gate";
import { useHome, useStudioReach } from "../hooks/use-can-reach";
import { usePermissions } from "../hooks/use-permissions";
import { useReplacePage } from "../lib/modal-route";
import { DashboardPage } from "./dashboard";

/** `/`: sends the reader home (`useHome`), or refuses a role with nowhere to go. */
export function HomePage() {
  switch (useHome()) {
    case "dashboard":
      return <ToPage pathname="/dashboard" />;
    case "chat":
      return <ToPage pathname="/chat" />;
    case "pending":
      return <HomeSkeleton />;
    case "denied":
      return <NoAccessState />;
  }
}

/** What `/` draws while the reader's home is still undecided. */
export function HomeSkeleton() {
  return <DashboardSkeleton />;
}

/** `/dashboard`: the Studio's dashboard, refused to a role without the Studio. */
export function DashboardRoute() {
  const { ready } = usePermissions();
  if (useStudioReach()) return <DashboardPage />;
  return ready ? <NoAccessState /> : <DashboardSkeleton />;
}

/** Opens `pathname` in place of `/`, keeping its query and an overlay opened over it (a pasted settings link). */
function ToPage({ pathname }: { pathname: string }) {
  const { search } = useLocation();
  const replacePage = useReplacePage();
  const go = useEffectEvent(() => replacePage(pathname, search));
  useEffect(() => go(), []);
  return null;
}
