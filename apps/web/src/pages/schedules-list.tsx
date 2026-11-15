// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { PageHeader } from "../components/page-header";
import { SchedulesCollection } from "../components/schedules-collection";
import { PageActionsMenu } from "../components/page-actions-menu";
import type { MenuAction } from "../lib/menu-action";
import { NewScheduleModal } from "../components/new-schedule-modal";
import { useOverviewMode } from "../hooks/use-overview-mode";

export function SchedulesListPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const [newScheduleOpen, setNewScheduleOpen] = useState(false);
  // « Vue d'ensemble »: every space by default, read-only (a schedule is created in one space).
  const { on: overview } = useOverviewMode();
  const canCreate = !overview && can("schedules:write");

  const createAction: MenuAction = {
    id: "create",
    label: t("schedules.create"),
    icon: Plus,
    onSelect: () => setNewScheduleOpen(true),
    hidden: !canCreate,
  };

  return (
    <div>
      <PageHeader
        title={t("common:nav.schedules")}
        variant="collection"
        breadcrumbs={[{ label: t("common:nav.schedules") }]}
        actions={canCreate ? <PageActionsMenu actions={[createAction]} /> : undefined}
      />
      <SchedulesCollection
        spaceDefault={overview ? "all" : "current"}
        createAction={overview ? undefined : createAction}
      />
      {newScheduleOpen && <NewScheduleModal onClose={() => setNewScheduleOpen(false)} />}
    </div>
  );
}
