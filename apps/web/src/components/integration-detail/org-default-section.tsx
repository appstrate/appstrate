// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { keepAvailable, unavailableConnectionIds } from "../../lib/connection-set";
import {
  useIntegrationOrgDefault,
  useIntegrationConnections,
  useUpsertIntegrationOrgDefault,
  useDeleteIntegrationOrgDefault,
} from "../../hooks/use-integrations";
import { ConnectionOptionLabel, ConnectionSetChecklist } from "./connection-set-checklist";

/**
 * Org-wide default connection for this integration — the cross-agent
 * baseline every consuming agent uses unless a per-agent exception (pin)
 * overrides it. `enforce` locks members; otherwise it's a soft default a
 * member can still override with their own pick.
 */
export function OrgDefaultSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation("settings");
  const { data: orgDefault } = useIntegrationOrgDefault(packageId);
  const { data: connections } = useIntegrationConnections(packageId);
  const upsert = useUpsertIntegrationOrgDefault();
  const remove = useDeleteIntegrationOrgDefault();

  const shared = (connections ?? []).filter((c) => c.shared_with_org === true);

  const [connectionIds, setConnectionIds] = useState<string[]>([]);
  const [enforce, setEnforce] = useState(false);

  // Seeded with only what is still shared, so the form shows what a save writes; the stored
  // members no longer shared are named apart — every run falling back on them is refused.
  const sharedIds = shared.map((c) => c.id);
  const seedIds = keepAvailable(orgDefault?.connection_ids ?? [], sharedIds);
  // Until the list loads, every stored member would read as unavailable.
  const unavailableIds = connections
    ? unavailableConnectionIds(orgDefault?.connection_ids ?? [], sharedIds)
    : [];
  // Sorted: a server reordering of the set must not read as a change and wipe the edit.
  const seededFor = orgDefault ? [...seedIds].sort().join(",") : null;
  const [seeded, setSeeded] = useState<string | null>(null);
  if (seededFor !== seeded) {
    setSeeded(seededFor);
    setConnectionIds(seedIds);
    setEnforce(orgDefault?.enforce ?? false);
  }

  const clearButton = orgDefault ? (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => remove.mutate({ params: { path: { packageId } } })}
      disabled={remove.isPending}
      data-testid="org-default-clear"
    >
      {t("integration.admin.orgDefault.clear")}
    </Button>
  ) : null;

  return (
    <div
      className="border-border bg-muted/30 mb-6 rounded-md border p-4"
      data-testid="org-default-section"
    >
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{t("integration.admin.orgDefault.title")}</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("integration.admin.orgDefault.help")}
        </p>
      </div>

      {unavailableIds.length > 0 && (
        <div
          className="mb-3 flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[0.7rem] text-amber-700 dark:text-amber-300"
          data-testid="org-default-unavailable-warning"
        >
          <AlertTriangle className="size-3 shrink-0" />
          <span>
            {t("integration.admin.orgDefault.unavailableWarning", {
              count: unavailableIds.length,
            })}
          </span>
        </div>
      )}

      {shared.length === 0 ? (
        <div className="flex items-center gap-3">
          <p className="text-muted-foreground text-xs italic">
            {t("integration.admin.orgDefault.noPinnableConnections")}
          </p>
          {clearButton}
        </div>
      ) : (
        <div className="border-border bg-background flex flex-wrap items-end gap-3 rounded-md border p-3">
          <div className="min-w-[14rem] flex-1">
            <Label className="text-muted-foreground mb-1 block text-[0.65rem]">
              {t("integration.admin.orgDefault.connections")}
            </Label>
            <ConnectionSetChecklist
              options={shared.map((c) => ({
                id: c.id,
                label: <ConnectionOptionLabel connection={c} />,
              }))}
              value={connectionIds}
              onChange={(next) => setConnectionIds(next ?? [])}
              idPrefix="org-default-connection"
              unavailableIds={unavailableIds}
            />
          </div>
          <div className="flex items-center gap-2 pb-1 text-xs">
            <Checkbox
              id="org-default-enforce"
              checked={enforce}
              onCheckedChange={(v) => setEnforce(v === true)}
              data-testid="org-default-enforce"
            />
            <label htmlFor="org-default-enforce">{t("integration.admin.orgDefault.enforce")}</label>
          </div>
          <Button
            size="sm"
            onClick={() =>
              upsert.mutate({
                params: { path: { packageId } },
                body: { connection_ids: connectionIds, enforce },
              })
            }
            disabled={connectionIds.length === 0 || upsert.isPending}
            data-testid="org-default-save"
          >
            {t("integration.admin.orgDefault.save")}
          </Button>
          {clearButton}
        </div>
      )}
    </div>
  );
}
