// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { RefreshCw, Activity, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUnreadCount, useMarkAllRead } from "../hooks/use-notifications";
import { RunList } from "../components/run-list";
import { RichEmptyState } from "../components/rich-empty-state";
import { usePaginatedRuns, type RunKindFilter } from "../hooks/use-paginated-runs";

type UserTab = "all" | "me";

export function RunsPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { data: unreadCount } = useUnreadCount();
  const markAllRead = useMarkAllRead();
  const [userTab, setUserTab] = useState<UserTab>("all");
  const [kindTab, setKindTab] = useState<RunKindFilter>("all");

  const { data: countData } = usePaginatedRuns({
    user: userTab === "me" ? "me" : undefined,
    kind: kindTab,
    limit: 15,
    offset: 0,
  });
  const total = countData?.total ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1300px] p-8 pb-16">
      {/* Page head */}
      <div className="mb-5 flex flex-wrap items-center gap-4">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-[1.6rem] font-bold tracking-tight">{t("runs.title")}</h1>
          <span className="text-muted-foreground text-sm">
            {total} {t("runs.title").toLowerCase()}
          </span>
        </div>
        <span className="flex-1" />
        <Button
          variant="outline"
          onClick={() => markAllRead.mutate()}
          disabled={markAllRead.isPending || !unreadCount}
        >
          <RefreshCw className="size-4" /> {t("runs.markAllRead")}
        </Button>
      </div>

      {/* Toolbar: segmented filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={userTab} onValueChange={(v) => setUserTab(v as UserTab)}>
          <TabsList>
            <TabsTrigger value="all">{t("runs.filterAll")}</TabsTrigger>
            <TabsTrigger value="me">{t("runs.filterMine")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs value={kindTab} onValueChange={(v) => setKindTab(v as RunKindFilter)}>
          <TabsList>
            <TabsTrigger value="all">{t("runs.filterKindAll")}</TabsTrigger>
            <TabsTrigger value="package">{t("runs.filterKindPackage")}</TabsTrigger>
            <TabsTrigger value="inline">{t("runs.filterKindInline")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <RunList
        key={`${userTab}-${kindTab}`}
        pageSize={15}
        user={userTab === "me" ? "me" : undefined}
        kind={kindTab}
        emptyState={
          <RichEmptyState
            icon={Activity}
            title={t("runs.emptyTitle", { defaultValue: "Aucune exécution pour l'instant" })}
            description={t("runs.emptyDesc", {
              defaultValue:
                "Lancez un agent pour voir ses exécutions ici — statut, durée, logs et résultats en temps réel.",
            })}
            action={
              <Button asChild>
                <Link to="/agents">
                  <Plus className="size-4" /> {t("nav.agents", { ns: "common" })}
                </Link>
              </Button>
            }
          />
        }
      />
    </div>
  );
}
