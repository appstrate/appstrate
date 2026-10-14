// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Plus, Webhook } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { useWebhooks } from "../hooks/use-webhooks";
import { ErrorState, EmptyState, EmptyStateAction } from "@/components/page-states";
import { DataTable } from "@/components/data-table";
import { SettingsPageActions } from "@/components/settings/settings-page-actions";
import { PageActionsMenu } from "@/components/page-actions-menu";
import { useWebhookColumns } from "../components/webhook-columns";
import { useModalParam } from "@/hooks/use-modal-param";
import { NEW_WEBHOOK_PARAM, WebhookCreateModal } from "../components/webhook-create-modal";
import { usePermissions } from "@/hooks/use-permissions";
import { webhookResource } from "@/lib/webhook-permissions";

export function WebhooksPage() {
  const { t } = useTranslation(["settings", "common"]);
  const newWebhook = useModalParam(NEW_WEBHOOK_PARAM);
  const { can } = usePermissions();

  const { data: webhooks, isLoading, error } = useWebhooks();
  const columns = useWebhookColumns();

  // One grant per level (`webhooks` in the space, `org-webhooks` across the
  // org); the modal offers the levels the caller holds.
  const createLevels = (["space", "org"] as const).filter((level) =>
    can(`${webhookResource(level)}:write`),
  );
  const canCreate = createLevels.length > 0;

  return (
    <div>
      {canCreate && (
        <SettingsPageActions>
          <PageActionsMenu>
            <DropdownMenuItem data-page-action="create" onSelect={() => newWebhook.open()}>
              <Plus />
              {t("settings:webhooks.createTitle")}
            </DropdownMenuItem>
          </PageActionsMenu>
        </SettingsPageActions>
      )}

      <DataTable
        tableId="webhooks"
        label={t("settings:webhooks.pageTitle")}
        columns={columns}
        rows={webhooks ?? []}
        rowKey={(wh) => wh.id}
        rowHref={(wh) => `/workspace-settings/webhooks/${wh.id}`}
        rowLabel={(wh) => wh.url}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState error={error} compact />}
        empty={
          <EmptyState message={t("settings:webhooks.empty")} icon={Webhook}>
            {canCreate && (
              <EmptyStateAction
                label={t("settings:webhooks.createTitle")}
                onClick={() => newWebhook.open()}
              />
            )}
          </EmptyState>
        }
      />

      {canCreate && <WebhookCreateModal levels={createLevels} />}
    </div>
  );
}
