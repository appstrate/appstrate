import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useUnreadCount, useMarkAllRead } from "../hooks/use-notifications";
import { PageHeader } from "../components/page-header";
import { ExecutionList } from "../components/execution-list";

export function ExecutionsPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { data: unreadCount } = useUnreadCount();
  const markAllRead = useMarkAllRead();

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
      />

      <ExecutionList pageSize={15} />
    </>
  );
}
