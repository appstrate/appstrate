// SPDX-License-Identifier: Apache-2.0

// Scoping headers for hand-rolled fetches that bypass the typed API client
// (SSE streams, uploads) — mirrors the `X-Org-Id` / `X-Application-Id`
// injection the client middleware performs (see `api/client.ts`). Module
// shells hand this to their packaged UI as the `getHeaders` prop.

import { getCurrentOrgId } from "../stores/org-store";
import { getCurrentApplicationId } from "../stores/app-store";

// Single source of truth for the org/app scoping-header wire contract.
// The typed API client middleware (`api/client.ts`) and the hand-rolled
// fetches both consume this so the header names can never drift apart.
export function buildScopingHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const orgId = getCurrentOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;
  const applicationId = getCurrentApplicationId();
  if (applicationId) headers["X-Application-Id"] = applicationId;
  return headers;
}
