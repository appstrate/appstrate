// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@appstrate/ui/components/badge";
import { useTranslation } from "react-i18next";

/**
 * "This model's credential can no longer serve inference" — the read-side
 * counterpart of `needs_reconnection`. Mirrors the badge the credentials table
 * already renders for the credential itself, so the two tables read the same.
 *
 * Wording is credential-neutral on purpose: the flag is also raised for an
 * api-key credential whose stored secret no longer decrypts, where
 * "reconnect the OAuth account" would be wrong advice.
 */
export function ModelUnavailableBadge({ className }: { className?: string }) {
  const { t } = useTranslation("settings");
  return (
    <Badge variant="failed" className={className} title={t("models.credentialUnavailableHint")}>
      {t("models.credentialUnavailable")}
    </Badge>
  );
}
