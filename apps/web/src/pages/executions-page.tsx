import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUnreadCount, useMarkAllRead } from "../hooks/use-notifications";
import { PageHeader } from "../components/page-header";
import { ExecutionList } from "../components/execution-list";

type UserTab = "all" | "me";

export function ExecutionsPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { data: unreadCount } = useUnreadCount();
  const markAllRead = useMarkAllRead();
  const [userTab, setUserTab] = useState<UserTab>("all");

  return (
    <>
      <PageHeader
        title={t("executions.title")}
        emoji="▶️"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("executions.title") },
        ]}
        actions={
          <Button
            variant="outline"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending || !unreadCount}
          >
            {t("executions.markAllRead")}
          </Button>
        }
      >
        <Tabs value={userTab} onValueChange={(v) => setUserTab(v as UserTab)} className="mt-2">
          <TabsList>
            <TabsTrigger value="all">{t("executions.filterAll")}</TabsTrigger>
            <TabsTrigger value="me">{t("executions.filterMine")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

      <ExecutionList key={userTab} pageSize={15} user={userTab === "me" ? "me" : undefined} />
    </>
  );
}
