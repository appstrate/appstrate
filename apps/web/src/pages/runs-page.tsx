// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { CheckCheck } from "lucide-react";
import { useUnreadRunCount, useMarkAllRunsRead } from "../hooks/use-run-reads";
import { PageHeader } from "../components/page-header";
import { RunsCollection } from "../components/runs-collection";
import { PageActionsMenu } from "../components/page-actions-menu";
import { useSpaceFilter } from "../hooks/use-space-filter";
import { LIST_ADMITS } from "../lib/space-lists";
import { useOverviewMode } from "../hooks/use-overview-mode";

/** `?status=failed,timeout` — the wire shape the endpoint takes. */
export function RunsPage() {
  const { t } = useTranslation(["agents", "common"]);
  // « Vue d'ensemble »: every space by default, read-only.
  const { on: overview } = useOverviewMode();
  const spaceDefault = overview ? "all" : "current";
  const unreadCount = useUnreadRunCount(!overview);
  const markAllRead = useMarkAllRunsRead();
  const { spaceIds } = useSpaceFilter(LIST_ADMITS.runs, spaceDefault);

  return (
    <div>
      <PageHeader
        title={t("runs.title")}
        variant="collection"
        breadcrumbs={[{ label: t("runs.title") }]}
        actions={
          <PageActionsMenu
            actions={[
              {
                id: "mark-all-read",
                label: t("common:notifications.markAllRead"),
                icon: CheckCheck,
                onSelect: () => markAllRead.mutate({}),
                disabled: markAllRead.isPending || !unreadCount,
                // It marks the CURRENT space's runs only: across spaces, the other rows would stay unread.
                hidden: spaceIds.length > 0,
              },
            ]}
          />
        }
      />
      <RunsCollection spaceDefault={spaceDefault} />
    </div>
  );
}
