// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { formatBytes } from "../lib/format-bytes";
import { useOrgDetail } from "./use-org";

/**
 * Single source of truth for the org storage gauge. `limitBytes` null = unlimited; `percent` is
 * the clamped 0–100 integer (null when unlimited); `usageLabel` is the usage sentence, null until loaded.
 */
export function useOrgStorage(options?: { enabled?: boolean }) {
  const { t } = useTranslation("settings");
  const { data: orgDetail, isLoading } = useOrgDetail(options);

  const storage = orgDetail?.storage;
  const usedBytes = storage?.used_bytes ?? null;
  const limitBytes = storage?.effective_limit_bytes ?? null;
  // A ZERO limit is a valid quota (every write refused): saturated (100), not unlimited.
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
