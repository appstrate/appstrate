// SPDX-License-Identifier: Apache-2.0

import { Navigate, useLocation } from "react-router-dom";
import { DashboardSkeleton } from "../components/loading-skeletons";
import { NoAccessState } from "../components/route-gate";
import { useHome } from "../hooks/use-can-reach";
import { DashboardPage } from "./dashboard";

/** `/`: the Studio's dashboard, or the chat for a role without the Studio. */
export function HomePage() {
  const home = useHome();
  const { search } = useLocation();
  switch (home) {
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
