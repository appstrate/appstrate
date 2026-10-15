// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { formatBytes } from "../lib/format-bytes";
import { useOrgDetail } from "./use-org";

/**
 * Single source of truth for the org storage gauge. Wraps the org-detail fetch
 * (`GET /api/orgs/{orgId}`) and the used/limit/percent math so every page that
 * shows storage usage (billing, org-settings general, files) reads the same
 * numbers with the same clamping.
 *
 * `limitBytes` = effective_limit_bytes ?? null (null = unlimited). `percent` is
 * the clamped 0–100 integer, or null when unlimited (no meaningful ratio).
 *
 * `usageLabel` is the one sentence that states the usage (« 3 MB used of 1 GB »), or null until
 * the org detail has loaded.
 *
 * The optional `enabled` composes with the presence of an org id, so a caller
 * that must not fire the fetch yet passes `false`.
 */
export function useOrgStorage(options?: { enabled?: boolean }) {
  const { t } = useTranslation("settings");
  const { data: orgDetail, isLoading } = useOrgDetail(options);

  const storage = orgDetail?.storage;
  const usedBytes = storage?.used_bytes ?? null;
  const limitBytes = storage?.effective_limit_bytes ?? null;
  // A hard ZERO limit is a valid quota (every write refused) — saturated, not
  // unlimited: percent is 100 so the gauge and near-limit warnings fire. Only
  // a null limit means unlimited (no meaningful ratio → null percent).
  const percent =
    storage && limitBytes !== null
      ? limitBytes > 0
        ? Math.min(100, Math.round((storage.used_bytes / limitBytes) * 100))
        : 100
      : null;

  const usageLabel = storage
    ? limitBytes === null
      ? t("orgStorage.usedUnlimited", { used: formatBytes(storage.used_bytes) })
      : t("orgStorage.usedOfLimit", {
          used: formatBytes(storage.used_bytes),
          limit: formatBytes(limitBytes),
        })
    : null;

  return { storage, usedBytes, limitBytes, percent, usageLabel, isLoading };
}
