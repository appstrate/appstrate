// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@appstrate/ui/components/collapsible";
import { useUpdateIntegrationSettings } from "../../hooks/use-integrations";
import { OrgDefaultSection } from "./org-default-section";
import { PinManagementSection } from "./pin-management-section";

/**
 * Org-wide access policy for this integration — collapsed by default, admin
 * only. Cross-cutting (not tied to one authKey): who may create connections,
 * the org-wide default, and per-agent pin exceptions.
 */
export function AccessRulesSection({
  packageId,
  blockUserConnections,
}: {
  packageId: string;
  blockUserConnections: boolean;
}) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-border bg-muted/20 rounded-md border"
      data-testid="access-rules-section"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <ChevronRight
          size={16}
          className={`text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-sm font-semibold">{t("integration.admin.accessRules.title")}</span>
        <span className="text-muted-foreground ml-2 text-xs">
          {t("integration.admin.accessRules.help")}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-2">
        <BlockUserConnectionsToggle packageId={packageId} initialBlocked={blockUserConnections} />
        <OrgDefaultSection packageId={packageId} />
        <PinManagementSection packageId={packageId} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function BlockUserConnectionsToggle({
  packageId,
  initialBlocked,
}: {
  packageId: string;
  initialBlocked: boolean;
}) {
  const { t } = useTranslation("settings");
  const updateSettings = useUpdateIntegrationSettings();
  // Drives the checkbox from server state — pending mutation reads the
  // about-to-be-applied value, idle reads the latest fetched value.
  const blocked =
    updateSettings.isPending && updateSettings.variables?.params.path.packageId === packageId
      ? updateSettings.variables.body.block_user_connections
      : initialBlocked;
  return (
    <div
      className="border-border bg-muted/30 mb-6 rounded-md border p-4"
      data-testid="block-user-connections-section"
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={blocked}
          disabled={updateSettings.isPending}
          onChange={(e) =>
            updateSettings.mutate({
              params: { path: { packageId } },
              body: { block_user_connections: e.target.checked },
            })
          }
          data-testid="block-user-connections-toggle"
          className="mt-0.5"
        />
        <div className="flex-1">
          <label className="text-sm font-semibold">
            {t("integration.admin.blockUserConnections.label")}
          </label>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("integration.admin.blockUserConnections.help")}
          </p>
        </div>
      </div>
    </div>
  );
}
