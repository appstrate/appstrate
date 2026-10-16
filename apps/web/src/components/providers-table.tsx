// SPDX-License-Identifier: Apache-2.0

/**
 * The providers table: the organization's keys and the personal keys connected (Settings ›
 * Models), and a person's own (Preferences › Mes clés). It owns what a row's menu needs to run (the connection test,
 * the name being edited); the page owns what the deeds do.
 */

import { useState, type ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { DataTable } from "./data-table";
import { EmptyState } from "./page-states";
import { useConnectionTest } from "../hooks/use-connection-test";
import {
  useProvidersRegistry,
  useTestModelProviderCredential,
} from "../hooks/use-model-provider-credentials";
import { useProviderColumns, type ProviderColumnsArgs } from "./provider-columns";
import type { ProviderRow } from "../lib/model-providers";

/** What the page decides: the deeds a row's menu offers, and the type column. */
type ProviderDeeds = Omit<
  ProviderColumnsArgs,
  "registry" | "testingIds" | "testResults" | "renamingId" | "onRenamingChange" | "onTest"
>;

export function ProvidersTable({
  label,
  rows,
  isLoading,
  error,
  empty,
  ...deeds
}: ProviderDeeds & {
  /** What the table holds, for its accessible name: the org's keys, the members', the caller's. */
  label: string;
  rows: ProviderRow[];
  isLoading: boolean;
  error: unknown;
  /** What an empty table says, and the deed it offers a caller who may. */
  empty: { message: string; hint?: string; action?: ReactNode };
}) {
  const { onChooseModels, canWriteModels } = deeds;
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
    ...deeds,
  });

  return (
    <DataTable
      label={label}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      // A click on an organization key's row chooses the models it serves.
      rowAction={(row) => row.credential && onChooseModels?.(row.credential)}
      rowActionable={(row) => row.kind === "org-key" && row.credential !== null && canWriteModels}
      rowLabel={(row) => row.label}
      isLoading={isLoading}
      failure={error}
      empty={
        <EmptyState message={empty.message} hint={empty.hint} icon={KeyRound} compact>
          {empty.action}
        </EmptyState>
      }
    />
  );
}
