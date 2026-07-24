// SPDX-License-Identifier: Apache-2.0

import { $api } from "../api/client";
import { useOrg } from "./use-org";

/**
 * Single source of truth for the org storage gauge. Wraps the org-detail fetch
 * (`GET /api/orgs/{orgId}`) and the used/limit/percent math so every page that
 * shows storage usage (billing, org-settings general, documents) reads the same
 * numbers with the same clamping.
 *
 * `limitBytes` = effective_limit_bytes ?? null (null = unlimited). `percent` is
 * the clamped 0–100 integer, or null when unlimited (no meaningful ratio).
 *
 * The optional `enabled` composes with the presence of an org id, mirroring the
 * per-page gating each caller used inline before (e.g. billing also gates on the
 * cloud feature flag).
 */
export function useOrgStorage(options?: { enabled?: boolean }) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const enabled = (options?.enabled ?? true) && !!orgId;

  const { data: orgDetail, isLoading } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled },
  );

  const storage = orgDetail?.storage;
  const usedBytes = storage?.used_bytes ?? null;
  const limitBytes = storage?.effective_limit_bytes ?? null;
  const percent =
    storage && limitBytes !== null && limitBytes > 0
      ? Math.min(100, Math.round((storage.used_bytes / limitBytes) * 100))
      : null;

  return { storage, usedBytes, limitBytes, percent, isLoading };
}
