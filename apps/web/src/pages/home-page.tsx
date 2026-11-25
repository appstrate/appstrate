// SPDX-License-Identifier: Apache-2.0

import { Navigate, useLocation } from "react-router-dom";
import { DashboardSkeleton } from "../components/loading-skeletons";
import { NoAccessState } from "../components/route-gate";
import { useCanReach, useStudioReach } from "../hooks/use-can-reach";
import { usePermissions } from "../hooks/use-permissions";
import { homeOf } from "../lib/home-route";
import { DashboardPage } from "./dashboard";

/** `/`: the Studio's dashboard, or the chat for a role without the Studio. */
export function HomePage() {
  const { ready } = usePermissions();
  const studio = useStudioReach();
  const chat = useCanReach()("/chat");
  const { search } = useLocation();
  switch (homeOf({ ready, studio, chat })) {
    case "dashboard":
      return <DashboardPage />;
    case "pending":
      return <DashboardSkeleton />;
    case "chat":
      return <Navigate to={{ pathname: "/chat", search }} replace />;
    case "denied":
      return <NoAccessState />;
  }
}
