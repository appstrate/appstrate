// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Plus, Webhook } from "lucide-react";
import { useWebhooks } from "../hooks/use-webhooks";
import { EmptyState, EmptyStateAction } from "@/components/page-states";
import { DataTable } from "@/components/data-table";
import { SettingsPageActions } from "@/components/settings/settings-page-actions";
import type { MenuAction } from "@/lib/menu-action";
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
  const create: MenuAction = {
    id: "create",
    icon: Plus,
    label: t("settings:webhooks.createTitle"),
    onSelect: () => newWebhook.open(),
    hidden: createLevels.length === 0,
  };

  return (
    <div>
      <SettingsPageActions actions={[create]} />

      <DataTable
        tableId="webhooks"
        label={t("settings:webhooks.pageTitle")}
        columns={columns}
        rows={webhooks ?? []}
        rowKey={(wh) => wh.id}
        rowHref={(wh) => `/workspace-settings/webhooks/${wh.id}`}
        rowLabel={(wh) => wh.url}
        isLoading={isLoading}
        failure={error}
        empty={
          <EmptyState message={t("settings:webhooks.empty")} icon={Webhook}>
            <EmptyStateAction action={create} />
          </EmptyState>
        }
      />

      {!create.hidden && <WebhookCreateModal levels={createLevels} />}
    </div>
  );
}
