// SPDX-License-Identifier: Apache-2.0

/**
 * The providers table, one for the organization (Settings › Models) and one for a person
 * (Preferences › My providers). It owns what a row's menu needs to run (the connection test,
 * the name being edited); the page owns what the deeds do.
 */

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { DataTable } from "./data-table";
import { EmptyState, ErrorState } from "./page-states";
import { useConnectionTest } from "../hooks/use-connection-test";
import {
  useProvidersRegistry,
  useTestModelProviderCredential,
  type ModelProviderCredentialInfo,
} from "../hooks/use-model-provider-credentials";
import type { OrgModelInfo } from "../hooks/use-models";
import { useProviderColumns } from "../pages/org-settings/provider-columns";
import type { ProviderRow } from "../lib/model-providers";

export function ProvidersTable({
  rows,
  isLoading,
  error,
  empty,
  showType,
  canWriteModels,
  onRename,
  onChooseModels,
  onChangeKey,
  onReconnect,
  onDelete,
  onSetDefault,
}: {
  rows: ProviderRow[];
  isLoading: boolean;
  error: unknown;
  /** What an empty table says, and the deed it offers a caller who may. */
  empty: { message: string; hint?: string; action?: ReactNode };
  /** Preferences: the caller's keys are of two kinds, the column says which. */
  showType?: boolean;
  canWriteModels: boolean;
  onRename: (pk: ModelProviderCredentialInfo, label: string) => Promise<void>;
  /** Only the organization's page chooses models and sets the default. */
  onChooseModels?: (pk: ModelProviderCredentialInfo) => void;
  onChangeKey: (pk: ModelProviderCredentialInfo) => void;
  onReconnect: (pk: ModelProviderCredentialInfo) => void;
  onDelete: (pk: ModelProviderCredentialInfo) => void;
  onSetDefault?: (m: OrgModelInfo) => void;
}) {
  const { t } = useTranslation("settings");
  const { testingIds, testResults, handleTest } = useConnectionTest(
    useTestModelProviderCredential(),
  );
  // Provider icons are a nicety: a reader without the registry's permission gets none.
  const { data: registry } = useProvidersRegistry();
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const columns = useProviderColumns({
    registry,
    testingIds,
    testResults,
    renamingId,
    onRenamingChange: setRenamingId,
    onTest: handleTest,
    onRename,
    onChooseModels,
    onChangeKey,
    onReconnect,
    onDelete,
    onSetDefault,
    canWriteModels,
    showType,
  });

  return (
    <DataTable
      label={t("providers.tableLabel")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      // A click on an organization key's row chooses the models it serves.
      rowAction={(row) => row.credential && onChooseModels?.(row.credential)}
      rowActionable={(row) => row.kind === "org-key" && row.credential !== null && canWriteModels}
      rowLabel={(row) => row.label}
      isLoading={isLoading}
      isError={Boolean(error)}
      error={<ErrorState error={error} compact />}
      empty={
        <EmptyState message={empty.message} hint={empty.hint} icon={KeyRound} compact>
          {empty.action}
        </EmptyState>
      }
    />
  );
}
