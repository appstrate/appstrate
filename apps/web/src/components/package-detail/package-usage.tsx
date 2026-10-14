// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
import { useAgents } from "../../hooks/use-packages";
import type { CardItem } from "../../pages/package-list";
import { matchesSearch } from "../../lib/strings";
import { PackagesTable } from "../packages-table";
import { usePackageColumns } from "../package-columns";
import { ListToolbar } from "../list-toolbar";
import { EmptyState } from "../page-states";

export function PackageUsage({ agentIds }: { agentIds: string[] }) {
  const { t } = useTranslation("agents");
  const { data: agents, isLoading, error } = useAgents();
  const [search, setSearch] = useState("");
  const columns = usePackageColumns("agent");
  const ids = new Set(agentIds);
  const items: CardItem[] = (agents ?? [])
    .filter((agent) => ids.has(agent.id))
    .map((agent) => ({
      id: agent.id,
      displayName: agent.display_name ?? agent.id,
      description: agent.description ?? null,
      type: "agent",
      source: agent.source,
      keywords: agent.keywords,
      runningRuns: agent.running_runs,
    }));
  return (
    <>
      <ListToolbar
        placement="panel"
        search={{ value: search, onChange: setSearch, placeholder: t("packages.usageSearch") }}
        filters={[]}
        onReset={() => setSearch("")}
      />
      <PackagesTable
        label={t("packages.usedBy")}
        columns={columns}
        items={items.filter((item) =>
          matchesSearch(search, [item.displayName, item.id, item.description]),
        )}
        surface="integrated"
        isLoading={isLoading}
        isError={Boolean(error)}
        empty={<EmptyState message={t("packages.noAgents")} icon={Layers} compact />}
      />
    </>
  );
}
