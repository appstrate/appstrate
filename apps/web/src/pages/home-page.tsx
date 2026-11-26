// SPDX-License-Identifier: Apache-2.0

import { useEffect, useEffectEvent } from "react";
import { useLocation } from "react-router-dom";
import { DashboardSkeleton } from "../components/loading-skeletons";
import { NoAccessState } from "../components/route-gate";
import { useHome } from "../hooks/use-can-reach";
import { useReplacePage } from "../lib/modal-route";
import { DashboardPage } from "./dashboard";

/** `/`: the Studio's dashboard, or the chat for a role without the Studio. */
export function HomePage() {
  switch (useHome()) {
    case "dashboard":
      return <DashboardPage />;
    case "pending":
      return <DashboardSkeleton />;
    case "chat":
      return <ToChat />;
    case "denied":
      return <NoAccessState />;
  }
}

/** Opens the chat in place of `/`, keeping an overlay opened over it (a pasted settings link). */
function ToChat() {
  const { search } = useLocation();
  const replacePage = useReplacePage();
  const go = useEffectEvent(() => replacePage("/chat", search));
  useEffect(() => go(), []);
  return null;
}
