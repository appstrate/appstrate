// SPDX-License-Identifier: Apache-2.0

import { Navigate, useLocation } from "react-router-dom";

/**
 * `<Navigate replace>` that carries the current navigation state across.
 *
 * A plain redirect drops it, which silently breaks routed modals: opening
 * `/org-settings` bounces to `/org-settings/general` and the
 * `backgroundLocation` that made it an overlay is gone by the time anything
 * reads it, so the modal renders as a full page instead.
 */
export function NavigateKeepingState({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={to} replace state={location.state} />;
}
