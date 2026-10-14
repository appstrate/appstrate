// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth clients admin tab for org/space settings pages.
 * Lists registered clients and lets admins register, edit, rotate secrets
 * for, disable, and delete them.
 *
 * Mounted only on routes declared `feature: "oidc"` (`lib/route-access.ts`),
 * so the OIDC module is always loaded here.
 */

import { useTranslation } from "react-i18next";
import { Plus, KeyRound } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { DataTable } from "@/components/data-table";
import { SettingsPageActions } from "@/components/settings/settings-page-actions";
import { PageActionsMenu } from "@/components/page-actions-menu";
import { ErrorState, EmptyState, EmptyStateAction } from "@/components/page-states";
import { usePermissions } from "@/hooks/use-permissions";
import { useModalParam, useModalTarget } from "@/hooks/use-modal-param";
import { useOAuthClients } from "../hooks/use-oauth-clients";
import { OAuthClientFormModal } from "./oauth-client-form-modal";
import { useOAuthClientColumns } from "./oauth-client-columns";

interface OAuthClientsTabProps {
  level?: "org" | "space";
}

export function OAuthClientsTab({ level }: OAuthClientsTabProps) {
  const { t } = useTranslation(["settings", "common"]);
  const { data, isLoading, error } = useOAuthClients(level);
  const { can } = usePermissions();
  const canWrite = can("oauth-clients:write");
  const newClient = useModalParam("newOAuthClient");
  const editClient = useModalTarget("oauth-client", data, (client) => client.clientId);
  const selectedClient = editClient.target ?? null;

  const columns = useOAuthClientColumns({
    onEdit: (client) => editClient.open(client.clientId),
  });

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-muted-foreground max-w-xl text-sm">
          {t(
            level === "space"
              ? "settings:oauthClients.introSpace"
              : "settings:oauthClients.introOrg",
          )}
        </p>
        {canWrite && (
          <SettingsPageActions>
            <PageActionsMenu>
              <DropdownMenuItem data-page-action="create" onSelect={() => newClient.open()}>
                <Plus />
                {t("settings:oauthClients.createBtn")}
              </DropdownMenuItem>
            </PageActionsMenu>
          </SettingsPageActions>
        )}
      </div>

      <DataTable
        label={t("settings:oauthClients.tableLabel")}
        tableId="oauth-clients"
        columns={columns}
        rows={data ?? []}
        rowKey={(client) => client.clientId}
        rowAction={canWrite ? (client) => editClient.open(client.clientId) : undefined}
        rowLabel={(client) =>
          t("settings:oauthClients.editClient", { name: client.name ?? client.clientId })
        }
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState error={error} compact />}
        empty={
          <EmptyState message={t("settings:oauthClients.empty")} icon={KeyRound}>
            {canWrite && (
              <EmptyStateAction
                label={t("settings:oauthClients.createBtn")}
                onClick={() => newClient.open()}
              />
            )}
          </EmptyState>
        }
      />

      <OAuthClientFormModal
        open={canWrite && (newClient.value !== null || selectedClient !== null)}
        onClose={selectedClient ? editClient.close : newClient.close}
        client={selectedClient}
        level={level}
      />
    </div>
  );
}
