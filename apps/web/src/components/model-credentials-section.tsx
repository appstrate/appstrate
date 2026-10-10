// SPDX-License-Identifier: Apache-2.0

/**
 * The model-provider credentials table, shared by the organization page and the
 * caller's own Preferences page. Its rows are whatever the caller may see: an
 * administrator's list holds the organization's rows, a member's only their own.
 */

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
import { EmptyState, ErrorState } from "./page-states";

export function CredentialsSection({
  credentials,
  isLoading,
  error,
  onEdit,
  onDelete,
  onRename,
  onConnectOAuth,
  canWrite,
  canDelete,
  userId,
  showOwner,
  empty,
}: {
  credentials: ModelProviderCredentialInfo[] | undefined;
  isLoading: boolean;
  error: unknown;
  onEdit: (pk: ModelProviderCredentialInfo) => void;
  onDelete: (pk: ModelProviderCredentialInfo) => void;
  onRename: (pk: ModelProviderCredentialInfo, newLabel: string) => Promise<void>;
  onConnectOAuth: (credential: ModelProviderCredentialInfo) => void;
  /** Whether the caller may change the organization's rows (adding is the host page's control). */
  canWrite: boolean;
  canDelete: boolean;
  /** The caller: a personal credential is editable only by its owner. */
  userId: string | undefined;
  /** Whether the owner column shows; a personal-only list has one owner, the caller. */
  showOwner: boolean;
  /** Empty-state copy; the organization's by default. */
  empty?: { message: string; hint?: string };
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestModelProviderCredential();
  const { testingIds, testResults, handleTest } = useConnectionTest(testMutation);
  const { data: registry } = useProvidersRegistry();

  const columns = useCredentialColumns({
    canWrite,
    canDelete,
    userId,
    showOwner,
    registry,
    testingIds,
    testResults,
    onTest: handleTest,
    onEdit,
    onDelete,
    onRename,
    onConnectOAuth,
  });

  const emptyCopy = empty ?? { message: t("credentials.empty"), hint: t("credentials.emptyHint") };

  return (
    <div className="mb-8">
      <DataTable
        label={t("credentials.title")}
        columns={columns}
        rows={credentials ?? []}
        rowKey={(pk) => pk.id}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState error={error} compact />}
        empty={
          <EmptyState message={emptyCopy.message} hint={emptyCopy.hint} icon={KeyRound} compact />
        }
      />
    </div>
  );
}
