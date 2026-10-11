// SPDX-License-Identifier: Apache-2.0

/**
 * The caller's own model providers (Preferences › Mes fournisseurs): a table whose rows hold
 * every deed in their « … » menu. The organization's providers are the grouped models table.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { useConnectionTest } from "../hooks/use-connection-test";
import {
  useProvidersRegistry,
  useTestModelProviderCredential,
  type ModelProviderCredentialInfo,
} from "../hooks/use-model-provider-credentials";
import { useCredentialColumns } from "../pages/org-settings/model-columns";
import { DataTable } from "./data-table";
import { EmptyState, EmptyStateAction, ErrorState } from "./page-states";

export function CredentialsSection({
  credentials,
  isLoading,
  error,
  onEdit,
  onDelete,
  onRename,
  onConnectOAuth,
  onAdd,
  empty,
}: {
  credentials: ModelProviderCredentialInfo[] | undefined;
  isLoading: boolean;
  error: unknown;
  onEdit: (pk: ModelProviderCredentialInfo) => void;
  onDelete: (pk: ModelProviderCredentialInfo) => void;
  onRename: (pk: ModelProviderCredentialInfo, newLabel: string) => Promise<void>;
  onConnectOAuth: (credential: ModelProviderCredentialInfo) => void;
  /** The page's « add » deed (in its Actions menu), given only to a caller who may add: the empty list repeats it. */
  onAdd?: () => void;
  /** Empty-state copy. */
  empty: { message: string; hint?: string };
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestModelProviderCredential();
  const { testingIds, testResults, handleTest } = useConnectionTest(testMutation);
  const { data: registry } = useProvidersRegistry();

  const [renamingId, setRenamingId] = useState<string | null>(null);

  const columns = useCredentialColumns({
    registry,
    renamingId,
    onRenamingChange: setRenamingId,
    testingIds,
    testResults,
    onTest: handleTest,
    onEdit,
    onDelete,
    onRename,
    onConnectOAuth,
  });

  return (
    <div className="mb-8">
      <DataTable
        label={t("credentials.title")}
        columns={columns}
        rows={credentials ?? []}
        rowKey={(pk) => pk.id}
        // A click on a row changes what it holds: the key, or the pairing of a subscription.
        rowAction={(pk) => (pk.authMode === "oauth2" ? onConnectOAuth(pk) : onEdit(pk))}
        rowActionable={(pk) =>
          pk.source === "custom" &&
          (pk.authMode === "oauth2"
            ? pk.needs_reconnection === true && pk.allowed_actions.includes("reconnect")
            : pk.allowed_actions.includes("edit"))
        }
        rowLabel={(pk) => pk.label}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState error={error} compact />}
        empty={
          <EmptyState message={empty.message} hint={empty.hint} icon={KeyRound} compact>
            {onAdd && <EmptyStateAction label={t("credentials.add")} onClick={onAdd} />}
          </EmptyState>
        }
      />
    </div>
  );
}
