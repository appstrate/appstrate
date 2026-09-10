// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
import { useAgents } from "../../hooks/use-packages";
import type { CardItem } from "../../pages/package-list";
import { packageDetailPath } from "../../lib/package-paths";
import { DataTable } from "../data-table";
import { usePackageColumns } from "../packages-table";
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
  const needle = search.trim().toLocaleLowerCase();
  return (
    <>
      <ListToolbar
        placement="panel"
        search={{ value: search, onChange: setSearch, placeholder: t("packages.usageSearch") }}
        filters={[]}
        onReset={() => setSearch("")}
      />
      <DataTable
        label={t("packages.usedBy")}
        columns={columns}
        rows={items.filter((item) =>
          `${item.displayName} ${item.id} ${item.description ?? ""}`
            .toLocaleLowerCase()
            .includes(needle),
        )}
        rowKey={(item) => item.id}
        rowHref={(item) => packageDetailPath("agent", item.id)}
        rowLabel={(item) => item.displayName}
        surface="integrated"
        columnMode="scroll"
        isLoading={isLoading}
        isError={Boolean(error)}
        empty={<EmptyState message={t("packages.noAgents")} icon={Layers} compact />}
      />
    </>
  );
}
