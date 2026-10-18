// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import type { DiscoveryBadges } from "../../lib/integration-discovery-merge";

/** Whether a field of the integration draft was read from the server or inferred by the analysis. */
export function DiscoveryBadge({
  provenance,
}: {
  provenance: DiscoveryBadges[string] | undefined;
}) {
  const { t } = useTranslation("agents");
  if (!provenance) return null;
  return (
    <Badge variant={provenance === "detected" ? "secondary" : "outline"} className="font-normal">
      {t(`integrationEditor.discover.${provenance}`)}
    </Badge>
  );
}
