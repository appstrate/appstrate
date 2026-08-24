// SPDX-License-Identifier: Apache-2.0

import { useParams } from "react-router-dom";
import { NavigateKeepingState } from "./navigate-keeping-state";

/**
 * `/org-settings/app/:tab` → `/workspace-settings/:tab`.
 *
 * Workspace settings used to live inside the organisation's, so those URLs are
 * in bookmarks and in docs. One redirect covers every tab rather than six.
 */
export function RedirectAppSettings() {
  const { tab } = useParams<{ tab: string }>();
  return <NavigateKeepingState to={`/workspace-settings/${tab ?? "general"}`} />;
}
