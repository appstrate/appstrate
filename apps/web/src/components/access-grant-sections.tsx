// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Laptop, Plug } from "lucide-react";
import { DataTable } from "./data-table";
import { EmptyState } from "./page-states";
import { SettingsGroup } from "./settings/setting-row";
import {
  useCliGrantColumns,
  useMcpGrantColumns,
  type AccessGrantRow,
} from "./access-grant-columns";

/**
 * A person's access grants, or an organization's, in two groups: the MCP
 * clients (Claude, Cursor, …) and the CLI / GitHub Action sessions. Both
 * lists come from one response; each group answers its own emptiness.
 */
export function AccessGrantSections({
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
  grants: AccessGrantRow[];
  isLoading: boolean;
  error: unknown;
  showHolder: boolean;
  revokingId: string | null;
  onRevoke?: (grant: AccessGrantRow) => void;
  emptyMcpHint: string;
  emptyCliHint: string;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const options = { showHolder, revokingId, onRevoke };
  const mcpColumns = useMcpGrantColumns(options);
  const cliColumns = useCliGrantColumns(options);
  const mcp = grants.filter((g) => g.kind === "mcp");
  const cli = grants.filter((g) => g.kind === "cli");

  return (
    <>
      <SettingsGroup title={t("accessGrants.mcpTitle")}>
        <DataTable
          tableId={`${tableIdPrefix}-mcp`}
          columns={mcpColumns}
          rows={mcp}
          rowKey={(g) => g.id}
          label={t("accessGrants.mcpTitle")}
          isLoading={isLoading}
          failure={error}
          empty={
            <EmptyState
              icon={Plug}
              message={t("accessGrants.mcpEmptyTitle")}
              hint={emptyMcpHint}
              compact
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title={t("accessGrants.cliTitle")}>
        <DataTable
          tableId={`${tableIdPrefix}-cli`}
          columns={cliColumns}
          rows={cli}
          rowKey={(g) => g.id}
          label={t("accessGrants.cliTitle")}
          isLoading={isLoading}
          failure={error}
          empty={
            <EmptyState
              icon={Laptop}
              message={t("devices.emptyTitle")}
              hint={emptyCliHint}
              compact
            />
          }
        />
      </SettingsGroup>
    </>
  );
}
