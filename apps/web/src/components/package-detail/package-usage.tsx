// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
import { useAgents } from "../../hooks/use-packages";
import { agentCardItem, type CardItem } from "../../lib/package-card-item";
import { useState } from "react";
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
    .map((agent) => agentCardItem(agent));
  return (
    <>
      <ListToolbar
        search={{ value: search, onChange: setSearch, placeholder: t("packages.usageSearch") }}
      />
      <PackagesTable
        label={t("packages.usedBy")}
        columns={columns}
        items={items.filter((item) =>
          matchesSearch(search, [item.displayName, item.id, item.description]),
        )}
        surface="integrated"
        isLoading={isLoading}
        failure={error}
        empty={<EmptyState message={t("packages.noAgents")} icon={Layers} compact />}
      />
    </>
  );
}
