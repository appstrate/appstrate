// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
import { useAgents } from "../../hooks/use-packages";
import { agentCardItem, type CardItem } from "../../lib/package-card-item";
import { useLocalListParams } from "../../lib/list-params";
import { matchesSearch } from "../../lib/strings";
import { PackagesTable } from "../packages-table";
import { usePackageColumns } from "../package-columns";
import { ListToolbar } from "../list-toolbar";
import { EmptyState, NoMatchState } from "../page-states";

export function PackageUsage({ agentIds }: { agentIds: string[] }) {
  const { t } = useTranslation("agents");
  const { data: agents, isLoading, error } = useAgents();
  const list = useLocalListParams();
  const columns = usePackageColumns("agent");
  const ids = new Set(agentIds);
  const items: CardItem[] = (agents ?? [])
    .filter((agent) => ids.has(agent.id))
    .map((agent) => agentCardItem(agent));
  return (
    <>
      <ListToolbar
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: t("packages.usageSearch"),
        }}
        onReset={list.reset}
      />
      <PackagesTable
        tableId="package-usage"
        label={t("packages.usedBy")}
        columns={columns}
        items={items.filter((item) =>
          matchesSearch(list.search, [item.displayName, item.id, item.description]),
        )}
        isLoading={isLoading}
        failure={error}
        empty={
          list.search ? (
            <NoMatchState message={t("list.noMatch")} onReset={list.reset} />
          ) : (
            <EmptyState message={t("packages.noAgents")} icon={Layers} compact />
          )
        }
      />
    </>
  );
}
