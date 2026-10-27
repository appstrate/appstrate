// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import type { Provenance } from "../../lib/integration-wizard";

const LABEL_KEYS = {
  detected: "integrationWizard.review.detected",
  guessed: "integrationWizard.review.guessed",
} as const;

/** Whether a field of the proposal was read from the server or inferred. */
export function DiscoveryBadge({ provenance }: { provenance: Provenance | undefined }) {
  const { t } = useTranslation("agents");
  if (!provenance) return null;
  return (
    <Badge variant={provenance === "detected" ? "secondary" : "outline"} className="font-normal">
      {t(LABEL_KEYS[provenance])}
    </Badge>
  );
}
