// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, Webhook } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { useWebhooks } from "../hooks/use-webhooks";
import { ErrorState, EmptyState } from "@/components/page-states";
import { DataTable } from "@/components/data-table";
import { SettingsPageActions } from "@/components/settings/settings-page-actions";
import { PageActionsMenu } from "@/components/page-actions-menu";
import { useWebhookColumns } from "../components/webhook-columns";
import { WebhookCreateModal } from "../components/webhook-create-modal";
import { getErrorMessage } from "@appstrate/core/errors";
import { usePermissions } from "@/hooks/use-permissions";

export function WebhooksPage() {
  const location = useLocation();
  const { t } = useTranslation(["settings", "common"]);
  const [createOpen, setCreateOpen] = useState(false);
  const { can } = usePermissions();

  const { data: webhooks, isLoading, error } = useWebhooks();
  const columns = useWebhookColumns();

  return (
    <div>
      {can("webhooks:write") && (
        <SettingsPageActions>
          <PageActionsMenu>
            <DropdownMenuItem data-page-action="create" onSelect={() => setCreateOpen(true)}>
              <Plus />
              {t("settings:webhooks.createTitle")}
            </DropdownMenuItem>
          </PageActionsMenu>
        </SettingsPageActions>
      )}

      <DataTable
        label={t("settings:webhooks.pageTitle")}
        columns={columns}
        rows={webhooks ?? []}
        rowKey={(wh) => wh.id}
        rowHref={(wh) => `/workspace-settings/webhooks/${wh.id}`}
        rowState={() => location.state}
        rowLabel={(wh) => wh.url}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={getErrorMessage(error)} compact />}
        empty={
          // The button above is the same one, and it stays.
          <EmptyState message={t("settings:webhooks.empty")} icon={Webhook} />
        }
      />

      <WebhookCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
