// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth clients admin tab for org/space settings pages.
 * Lists registered clients and lets admins register, edit, rotate secrets
 * for, disable, and delete them.
 *
 * Mounted only on routes declared `feature: "oidc"` (`lib/route-access.ts`),
 * so the OIDC module is always loaded here.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, KeyRound } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { SettingsPageActions } from "@/components/settings/settings-page-actions";
import type { MenuAction } from "@/lib/menu-action";
import { EmptyState, EmptyStateAction } from "@/components/page-states";
import { usePermissions } from "@/hooks/use-permissions";
import { useUrlModalTarget } from "@/hooks/use-url-modal";
import { useOAuthClients } from "../hooks/use-oauth-clients";
import { SecretRevealModal } from "@/components/secret-reveal-modal";
import { OAuthClientFormModal, type CreatedSecret } from "./oauth-client-form-modal";
import { useOAuthClientColumns } from "./oauth-client-columns";

interface OAuthClientsTabProps {
  level?: "org" | "space";
}

export function OAuthClientsTab({ level }: OAuthClientsTabProps) {
  const { t } = useTranslation(["settings", "common"]);
  const { data, isLoading, error } = useOAuthClients(level);
  const { can } = usePermissions();
  const canWrite = can("oauth-clients:write");
  const [creating, setCreating] = useState(false);
  const editClient = useUrlModalTarget("editOauthClient", data, (client) => client.clientId);
  const selectedClient = editClient.target ?? null;
  // Shown once, and with no address.
  const [createdSecret, setCreatedSecret] = useState<CreatedSecret | null>(null);

  const create: MenuAction = {
    id: "create",
    icon: Plus,
    label: t("settings:oauthClients.createBtn"),
    onSelect: () => setCreating(true),
    hidden: !canWrite,
  };

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
        <SettingsPageActions actions={[create]} />
      </div>

      <DataTable
        label={t("settings:oauthClients.tableLabel")}
        columns={columns}
        rows={data ?? []}
        rowKey={(client) => client.clientId}
        rowAction={canWrite ? (client) => editClient.open(client.clientId) : undefined}
        rowLabel={(client) =>
          t("settings:oauthClients.editClient", { name: client.name ?? client.clientId })
        }
        isLoading={isLoading}
        failure={error}
        empty={
          <EmptyState message={t("settings:oauthClients.empty")} icon={KeyRound}>
            <EmptyStateAction action={create} />
          </EmptyState>
        }
      />

      {canWrite && (creating || selectedClient !== null) && (
        <OAuthClientFormModal
          key={selectedClient?.clientId ?? "__create__"}
          onClose={selectedClient ? editClient.close : () => setCreating(false)}
          client={selectedClient}
          level={level}
          onCreated={(secret) => {
            setCreatedSecret(secret);
            setCreating(false);
          }}
        />
      )}

      {createdSecret && (
        <SecretRevealModal
          onClose={() => setCreatedSecret(null)}
          title={t("settings:oauthClients.createdTitle")}
          secret={`Client ID: ${createdSecret.clientId}\nClient Secret: ${createdSecret.clientSecret}`}
          warning={t("settings:oauthClients.secretWarning")}
        />
      )}
    </div>
  );
}
