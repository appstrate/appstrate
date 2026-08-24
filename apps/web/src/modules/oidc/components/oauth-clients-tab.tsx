// SPDX-License-Identifier: Apache-2.0

/** OAuth clients admin table for organization and workspace settings. */

import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, KeyRound } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { DataTable } from "@/components/data-table";
import { SettingsPageActions } from "@/components/settings/settings-page-actions";
import { ErrorState, EmptyState } from "@/components/page-states";
import { TOOLBAR_ACTION } from "@/lib/toolbar-button";
import { getErrorMessage } from "@appstrate/core/errors";
import { useOAuthClients } from "../hooks/use-oauth-clients";
import { OAuthClientFormModal } from "./oauth-client-form-modal";
import { useOAuthClientColumns } from "./oauth-client-columns";

interface OAuthClientsTabProps {
  level?: "org" | "application";
}

export function OAuthClientsTab({ level }: OAuthClientsTabProps) {
  const { t } = useTranslation(["settings", "common"]);
  const { data, isLoading, error } = useOAuthClients(level);
  const location = useLocation();
  const navigate = useNavigate();

  const selectedId = new URLSearchParams(location.search).get("oauth-client");
  const selectedClient =
    selectedId && selectedId !== "new"
      ? (data?.find((client) => client.clientId === selectedId) ?? null)
      : null;
  const modalOpen = selectedId === "new" || selectedClient !== null;

  const setSelectedClient = (clientId: string | null) => {
    const params = new URLSearchParams(location.search);
    if (clientId) params.set("oauth-client", clientId);
    else params.delete("oauth-client");
    const search = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : "",
        hash: location.hash,
      },
      { replace: clientId === null },
    );
  };

  const columns = useOAuthClientColumns({
    onEdit: (client) => setSelectedClient(client.clientId),
  });

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-muted-foreground max-w-xl text-sm">
          {t(
            level === "application"
              ? "settings:oauthClients.introApp"
              : "settings:oauthClients.introOrg",
          )}
        </p>
        <SettingsPageActions>
          <Button
            size="sm"
            variant="outline"
            className={TOOLBAR_ACTION}
            onClick={() => setSelectedClient("new")}
          >
            <Plus />
            {t("settings:oauthClients.createBtn")}
          </Button>
        </SettingsPageActions>
      </div>

      <DataTable
        label={t("settings:oauthClients.tableLabel")}
        columns={columns}
        rows={data ?? []}
        rowKey={(client) => client.clientId}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={getErrorMessage(error)} compact />}
        empty={<EmptyState message={t("settings:oauthClients.empty")} icon={KeyRound} />}
      />

      <OAuthClientFormModal
        open={modalOpen}
        onClose={() => setSelectedClient(null)}
        client={selectedClient}
        level={level}
      />
    </div>
  );
}
