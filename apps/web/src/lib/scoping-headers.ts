// SPDX-License-Identifier: Apache-2.0

import { getCurrentOrgId } from "../stores/org-store";
import { getCurrentApplicationId } from "../stores/app-store";

/**
 * Scoping headers (`X-Org-Id` / `X-Application-Id`) for module UIs that hit the
 * platform API with raw `fetch` instead of the typed client (which injects
 * them automatically). Mirrors the typed client's middleware.
 */
export function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const orgId = getCurrentOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;
  const applicationId = getCurrentApplicationId();
  if (applicationId) headers["X-Application-Id"] = applicationId;
  return headers;
}
