// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, KeyRound, Plus } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { ConfirmModal } from "../components/confirm-modal";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import {
  useApiKeys,
  useAvailableScopes,
  useRevokeApiKey,
  type ApiKeyInfo,
} from "../hooks/use-api-keys";
import { ErrorState, EmptyState } from "../components/page-states";
import { DataTable } from "../components/data-table";
import { SettingsPageActions } from "../components/settings/settings-page-actions";
import { PageActionsMenu } from "../components/page-actions-menu";
import { ApiKeyCreateModal } from "../components/api-key-create-modal";
import { getErrorMessage } from "@appstrate/core/errors";
import { useApiKeyColumns } from "./api-key-columns";

export function ApiKeysPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const applicationId = useCurrentApplicationId();
  const { data: apiKeys, isLoading, error } = useApiKeys();
  const { data: availableScopes } = useAvailableScopes();
  const revokeApiKeyMutation = useRevokeApiKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<{ id: string; label: string } | null>(null);

  const handleRevoke = (key: ApiKeyInfo) => {
    setConfirmState({ id: key.id, label: key.name });
  };
  const columns = useApiKeyColumns({
    availableScopes,
    revokingKeyId: revokeApiKeyMutation.isPending ? (confirmState?.id ?? null) : null,
    onRevoke: handleRevoke,
  });

  if (!isAdmin) return null;
  if (!applicationId)
    return <EmptyState message={t("applications.noAppSelected")} icon={KeyRound} />;

  return (
    <div>
      <SettingsPageActions>
        <PageActionsMenu>
          <DropdownMenuItem data-page-action="create" onSelect={() => setCreateOpen(true)}>
            <Plus />
            {t("settings:apiKeys.createBtn")}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a
              href="/api/docs"
              target="_blank"
              rel="noopener noreferrer"
              data-page-action="api-docs"
            >
              <ExternalLink />
              {t("settings:apiKeys.swaggerLink")}
            </a>
          </DropdownMenuItem>
        </PageActionsMenu>
      </SettingsPageActions>

      <DataTable
        label={t("settings:orgSettings.tabApiKeys")}
        columns={columns}
        rows={apiKeys ?? []}
        rowKey={(key) => key.id}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={getErrorMessage(error)} compact />}
        empty={
          <EmptyState
            message={t("settings:apiKeys.empty")}
            hint={t("settings:apiKeys.emptyHint")}
            icon={KeyRound}
            compact
          />
        }
      />

      <ApiKeyCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("settings:apiKeys.revokeConfirm", { name: confirmState?.label })}
        isPending={revokeApiKeyMutation.isPending}
        onConfirm={() => {
          if (!confirmState) return;
          revokeApiKeyMutation.mutate(
            { params: { path: { id: confirmState.id } } },
            {
              onSuccess: () => setConfirmState(null),
            },
          );
        }}
      />
    </div>
  );
}
