// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Laptop, Plug } from "lucide-react";
import { DataTable } from "./data-table";
import { EmptyState, ErrorState } from "./page-states";
import { SettingsGroup } from "./settings/setting-row";
import { useCliGrantColumns, useMcpGrantColumns } from "./access-grant-columns";
import type { AccessGrant } from "../lib/access-grants";

/**
 * A person's access grants, or an organization's, in two groups read from one
 * response: the MCP clients and the CLI / GitHub Action sessions.
 */
export function AccessGrantSections<T extends AccessGrant>({
  tableIdPrefix,
  grants,
  isLoading,
  error,
  showHolder,
  revokingId,
  onRevoke,
  emptyMcpHint,
  emptyCliHint,
}: {
  tableIdPrefix: string;
  grants: T[];
  isLoading: boolean;
  error: unknown;
  showHolder: boolean;
  revokingId: string | null;
  onRevoke?: (grant: T) => void;
  emptyMcpHint: string;
  emptyCliHint: string;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const options = { showHolder, revokingId, onRevoke };
  const mcpColumns = useMcpGrantColumns<T>(options);
  const cliColumns = useCliGrantColumns<T>(options);
  if (error) return <ErrorState error={error} />;

  const groups = [
    {
      kind: "mcp",
      title: t("accessGrants.mcpTitle"),
      columns: mcpColumns,
      empty: (
        <EmptyState
          icon={Plug}
          message={t("accessGrants.mcpEmptyTitle")}
          hint={emptyMcpHint}
          compact
        />
      ),
    },
    {
      kind: "cli",
      title: t("accessGrants.cliTitle"),
      columns: cliColumns,
      empty: (
        <EmptyState
          icon={Laptop}
          message={t("accessGrants.cliEmptyTitle")}
          hint={emptyCliHint}
          compact
        />
      ),
    },
  ] as const;
  return groups.map((group) => (
    <SettingsGroup key={group.kind} title={group.title}>
      <DataTable
        tableId={`${tableIdPrefix}-${group.kind}`}
        columns={group.columns}
        rows={grants.filter((g) => g.kind === group.kind)}
        rowKey={(g) => g.id}
        label={group.title}
        isLoading={isLoading}
        empty={group.empty}
      />
    </SettingsGroup>
  ));
}
