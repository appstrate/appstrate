// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import { MetaBadge } from "./status-badge";

/**
 * Where a run came from, when that is not an ordinary agent run: inline, its
 * agent deleted, or run remotely — each explains an action the run lacks.
 */
export function RunProvenanceBadges({ run }: { run: EnrichedRun }) {
  const { t } = useTranslation(["agents"]);
  return (
    <>
      {run.package_ephemeral === true && <MetaBadge label={t("runs.inlineBadge")} />}
      {/* `packageId == null` on a non-inline run: the source agent was deleted
          (FK SET NULL); the run survives, its agent page does not. */}
      {run.packageId == null && run.package_ephemeral !== true && (
        <MetaBadge label={t("runs.deletedAgentBadge")} title={t("runs.deletedAgentTitle")} italic />
      )}
      {run.runOrigin === "remote" && (
        <MetaBadge label={t("runs.remoteBadge")} title={t("runs.remoteBadgeTitle")} />
      )}
    </>
  );
}
