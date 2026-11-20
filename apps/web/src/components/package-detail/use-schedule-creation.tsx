// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { schemaHasFileFields } from "@appstrate/core/form";
import type { AgentDetail } from "@appstrate/shared-types";
import { useAgentSpaceAction } from "../../hooks/use-agent-run-space";
import { NewScheduleModal } from "../new-schedule-modal";
import { deedOfAction, spaceDeedLabels, type SpaceDeed } from "../space-deed";

/**
 * « Planifier » on an agent: the deed (the Actions menu's, the schedules tab's empty state) and the
 * dialog it opens. A schedule is created in one space: in « Tous les espaces », one of the agent's
 * the reader picks, the page entering it with the agent already read there. A schedule cannot
 * carry a file input: none is offered then.
 */
export function useScheduleCreation(packageId: string, detail: AgentDetail | undefined) {
  const { t } = useTranslation(["agents", "common"]);
  const [open, setOpen] = useState(false);
  const action = useAgentSpaceAction(packageId, "schedules:write", detail?.space_ids);
  const deed: SpaceDeed = {
    ...deedOfAction(
      action,
      spaceDeedLabels(t, "spaceChoice.schedule", "spaceChoice.scheduleIn"),
      () => setOpen(true),
    ),
    offered: action.offered && !schemaHasFileFields(detail?.input?.schema),
  };
  const dialog = open ? (
    <NewScheduleModal initialAgentId={packageId} onClose={() => setOpen(false)} />
  ) : null;
  return { deed, dialog };
}
