// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, Webhook } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import { Button } from "@appstrate/ui/components/button";
import { useWebhooks } from "../hooks/use-webhooks";
import { ErrorState, EmptyState } from "@/components/page-states";
import { DataTable } from "@/components/data-table";
import { SettingsPageActions } from "@/components/settings/settings-page-actions";
import { useWebhookColumns } from "../components/webhook-columns";
import { TOOLBAR_ACTION } from "@/lib/toolbar-button";
import { WebhookCreateModal } from "../components/webhook-create-modal";
import { getErrorMessage } from "@appstrate/core/errors";

export function WebhooksPage() {
  const location = useLocation();
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: webhooks, isLoading, error } = useWebhooks();
  const columns = useWebhookColumns();

  if (!isAdmin) return null;

  return (
    <div>
      <SettingsPageActions>
        <Button variant="outline" className={TOOLBAR_ACTION} onClick={() => setCreateOpen(true)}>
          <Plus />
          {t("settings:webhooks.createTitle")}
        </Button>
      </SettingsPageActions>

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
