// SPDX-License-Identifier: Apache-2.0

// Scoping headers for hand-rolled fetches that bypass the typed API client
// (SSE streams, uploads) — mirrors the `X-Org-Id` / `X-Application-Id`
// injection the client middleware performs (see `api/client.ts`). Module
// shells hand this to their packaged UI as the `getHeaders` prop.

import { getCurrentOrgId } from "../stores/org-store";
import { getCurrentApplicationId } from "../stores/app-store";

export function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const orgId = getCurrentOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;
  const applicationId = getCurrentApplicationId();
  if (applicationId) headers["X-Application-Id"] = applicationId;
  return headers;
}
