// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { useUnreadCount, useMarkAllRead } from "../hooks/use-notifications";
import { PageHeader } from "../components/page-header";
import { RunList } from "../components/run-list";
import type { RunKindFilter } from "../hooks/use-paginated-runs";

type UserTab = "all" | "me";

export function RunsPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { data: unreadCount } = useUnreadCount();
  const markAllRead = useMarkAllRead();
  const [userTab, setUserTab] = useState<UserTab>("all");
  const [kindTab, setKindTab] = useState<RunKindFilter>("all");

  return (
    <div className="p-6">
      <PageHeader
        title={t("runs.title")}
        emoji="▶️"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("runs.title") },
        ]}
        actions={
          <Button
            variant="outline"
            onClick={() => markAllRead.mutate({})}
            disabled={markAllRead.isPending || !unreadCount}
          >
            {t("runs.markAllRead")}
          </Button>
        }
      >
        {/* `collapse={false}` on both: shrink-to-fit flex items, so the measured
            width would be the bar's own content width and the overflow menu
            would feed on its own output. Two/three short filter triggers — they
            have nothing to collapse anyway. */}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Tabs value={userTab} onValueChange={(v) => setUserTab(v as UserTab)}>
            <TabsList collapse={false}>
              <TabsTrigger value="all">{t("runs.filterAll")}</TabsTrigger>
              <TabsTrigger value="me">{t("runs.filterMine")}</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs value={kindTab} onValueChange={(v) => setKindTab(v as RunKindFilter)}>
            <TabsList collapse={false}>
              <TabsTrigger value="all">{t("runs.filterKindAll")}</TabsTrigger>
              <TabsTrigger value="package">{t("runs.filterKindPackage")}</TabsTrigger>
              <TabsTrigger value="inline">{t("runs.filterKindInline")}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </PageHeader>

      <RunList
        key={`${userTab}-${kindTab}`}
        pageSize={15}
        user={userTab === "me" ? "me" : undefined}
        kind={kindTab}
      />
    </div>
  );
}
