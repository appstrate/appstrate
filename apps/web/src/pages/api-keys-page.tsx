// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, KeyRound, Plus } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { ConfirmModal } from "../components/confirm-modal";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import {
  useApiKeys,
  useAvailableScopes,
  useRevokeApiKey,
  type ApiKeyInfo,
} from "../hooks/use-api-keys";
import { EmptyState, EmptyStateAction } from "../components/page-states";
import { DataTable } from "../components/data-table";
import { SettingsPageActions } from "../components/settings/settings-page-actions";
import { PageActionsMenu } from "../components/page-actions-menu";
import { useModalParam } from "../hooks/use-modal-param";
import { ApiKeyCreateModal, NEW_API_KEY_PARAM } from "../components/api-key-create-modal";
import { useApiKeyColumns } from "./api-key-columns";

export function ApiKeysPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const canCreate = can("api-keys:create");
  const spaceId = useCurrentSpaceId();
  const { data: apiKeys, isLoading, error } = useApiKeys();
  const { data: availableScopes } = useAvailableScopes();
  const revokeApiKeyMutation = useRevokeApiKey();
  const newApiKey = useModalParam(NEW_API_KEY_PARAM);
  const [confirmState, setConfirmState] = useState<{ id: string; label: string } | null>(null);

  const handleRevoke = (key: ApiKeyInfo) => {
    setConfirmState({ id: key.id, label: key.name });
  };
  const columns = useApiKeyColumns({
    availableScopes,
    revokingKeyId: revokeApiKeyMutation.isPending ? (confirmState?.id ?? null) : null,
    onRevoke: can("api-keys:revoke") ? handleRevoke : undefined,
  });

  if (!can("api-keys:read")) return null;
  if (!spaceId) return <EmptyState message={t("spaces.noSpaceSelected")} icon={KeyRound} />;

  return (
    <div>
      <SettingsPageActions>
        <PageActionsMenu>
          {canCreate && (
            <DropdownMenuItem data-page-action="create" onSelect={() => newApiKey.open()}>
              <Plus />
              {t("settings:apiKeys.createBtn")}
            </DropdownMenuItem>
          )}
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
        tableId="api-keys"
        label={t("settings:orgSettings.tabApiKeys")}
        columns={columns}
        rows={apiKeys ?? []}
        rowKey={(key) => key.id}
        isLoading={isLoading}
        failure={error}
        empty={
          <EmptyState
            message={t("settings:apiKeys.empty")}
            hint={t("settings:apiKeys.emptyHint")}
            icon={KeyRound}
            compact
          >
            {canCreate && (
              <EmptyStateAction
                label={t("settings:apiKeys.createBtn")}
                onClick={() => newApiKey.open()}
              />
            )}
          </EmptyState>
        }
      />

      {canCreate && <ApiKeyCreateModal />}

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("settings:apiKeys.revokeTitle")}
        confirmLabel={t("settings:apiKeys.revoke")}
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
