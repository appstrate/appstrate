// SPDX-License-Identifier: Apache-2.0

import { Alert } from "@appstrate/ui/components/alert";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { AlertDescription } from "@appstrate/ui/components/alert";
import { OptionSelect } from "@/components/app-ui/option-select";
import { keepAvailable, unavailableConnectionIds } from "../../lib/connection-set";
import {
  useIntegrationOrgDefault,
  useIntegrationConnections,
  useIntegrationPins,
  useAgentsConsumingIntegration,
  useUpsertIntegrationOrgDefault,
  useDeleteIntegrationOrgDefault,
} from "../../hooks/use-integrations";
import { SettingsSkeleton } from "../loading-skeletons";
import { SaveFeedback } from "../settings/save-feedback";
import { ConnectionCheckboxList } from "./connection-checkbox-list";

/**
 * Org-wide default connections for this integration — the cross-agent
 * baseline every consuming agent uses unless a per-agent exception (pin)
 * overrides it. `enforce` locks members; otherwise it's a soft default a
 * member can still override with their own pick.
 *
 * The default is a SET (up to `MAX_CONNECTIONS_PER_INTEGRATION`), and
 * every subset is a valid default on its own, so each tick commits alone —
 * the rule for a list of independently valid values.
 */
export function OrgDefaultSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation("settings");
  const { data: orgDefault, isLoading, isError, refetch } = useIntegrationOrgDefault(packageId);
  const { data: connections, isLoading: connectionsLoading } = useIntegrationConnections(packageId);
  const { data: pins } = useIntegrationPins(packageId);
  const { data: consumingAgents } = useAgentsConsumingIntegration(packageId);
  const upsert = useUpsertIntegrationOrgDefault();
  const remove = useDeleteIntegrationOrgDefault();

  const shared = (connections ?? []).filter((c) => c.shared_here);
  const sharedIds = shared.map((c) => c.id);
  const storedIds = orgDefault?.connection_ids ?? [];
  // Stored members no longer shared are named apart: every run falling back on
  // them is refused. Until the list loads, every member would read as unavailable.
  const unavailableIds = connections ? unavailableConnectionIds(storedIds, sharedIds) : [];

  const [pendingValue, setPendingValue] = useState<{
    connection_ids: string[];
    enforce: boolean;
  } | null>(null);
  // Only what is still shared is ticked, so the next write is what the list shows.
  const connectionIds = pendingValue?.connection_ids ?? keepAvailable(storedIds, sharedIds);
  const enforce = pendingValue?.enforce ?? orgDefault?.enforce ?? false;
  const hasDefault = pendingValue ? pendingValue.connection_ids.length > 0 : !!orgDefault;
  const [draftMode, setDraftMode] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"success" | "error" | null>(null);
  const mode = draftMode ?? (hasDefault ? (enforce ? "forced" : "default") : "choice");
  // A stored default whose members are all unshared has nothing to write a mode change with (the
  // server refuses them): its connections are picked, or dropped, first.
  const modeLocked = !!orgDefault && pendingValue === null && connectionIds.length === 0;
  // An enforced default accepts no addition: it cannot be set while an admin pin of this
  // integration lets runs add to it (the server answers 409), so those agents are named. The
  // server ignores the pins of agents inactive in the space (`agent_active`), so only active
  // ones count; a name is the consuming agent's, else the package id.
  const openPinAgents = (pins ?? [])
    .filter(
      (p) =>
        p.integration_package_id === packageId && p.allow_additional_connections && p.agent_active,
    )
    .map(
      (p) =>
        consumingAgents?.find((a) => a.agent_package_id === p.agent_package_id)?.display_name ??
        p.agent_package_id,
    );
  const forcedLocked = openPinAgents.length > 0 && mode !== "forced";
  /** An empty set removes the default; `keepMode` holds the mode while the list is empty. */
  const save = async (nextIds: string[], nextEnforce: boolean, keepMode: string | null = null) => {
    setPendingValue({ connection_ids: nextIds, enforce: nextEnforce });
    setOutcome(null);
    if (nextIds.length === 0) setDraftMode(keepMode);
    try {
      if (nextIds.length > 0)
        await upsert.mutateAsync({
          params: { path: { packageId } },
          body: { connection_ids: nextIds, enforce: nextEnforce },
        });
      else await remove.mutateAsync({ params: { path: { packageId } } });
      await refetch();
      setOutcome("success");
    } catch {
      // The mutation's own `onError` has already said why.
      setOutcome("error");
    } finally {
      setPendingValue(null);
      if (nextIds.length > 0) setDraftMode(null);
    }
  };
  const connectionsLabel = t(
    `integration.admin.orgDefault.connection.${mode === "forced" ? "forced" : "default"}`,
  );

  return (
    <div className="flex flex-col gap-4" data-testid="org-default-section">
      {unavailableIds.length > 0 && (
        <Alert variant="warning" data-testid="org-default-unavailable-warning">
          <AlertTriangle className="size-4" />
          <AlertDescription className="flex flex-wrap items-start justify-between gap-3">
            <span>
              {t("integration.admin.orgDefault.unavailableWarning", {
                count: unavailableIds.length,
              })}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="-my-1.5"
              disabled={pendingValue !== null}
              onClick={() => void save(connectionIds, enforce)}
              data-testid="org-default-drop-unavailable"
            >
              {t("integration.admin.orgDefault.dropUnavailable", {
                count: unavailableIds.length,
              })}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {isLoading || connectionsLoading ? (
        <SettingsSkeleton rows={2} />
      ) : (
        <div className="grid items-start gap-6 md:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-3">
              <p className="text-sm font-medium">{t("integration.admin.usage.title")}</p>
            </div>

            <OptionSelect
              value={mode}
              disabled={isLoading || isError || pendingValue !== null}
              onValueChange={(value) => {
                if (value === "choice") {
                  setDraftMode(null);
                  if (orgDefault) void save([], false);
                } else if (connectionIds.length > 0) void save(connectionIds, value === "forced");
                else setDraftMode(value);
              }}
              aria-label={t("integration.admin.usage.title")}
              options={(["choice", "default", "forced"] as const).map((value) => ({
                value,
                label: t(`integration.admin.usage.${value}`),
                disabled:
                  (value !== "choice" && (shared.length === 0 || (modeLocked && value !== mode))) ||
                  (value === "forced" && forcedLocked),
              }))}
            />
            <p className="text-muted-foreground mt-2 text-sm">
              {t(`integration.admin.usage.${mode}Help`)}
            </p>
            {(mode === "forced" || orgDefault?.enforce === true) && (
              <p
                className="text-muted-foreground mt-1 text-sm"
                data-testid="org-default-clears-choices"
              >
                {t("integration.admin.orgDefault.clearsMemberChoices")}
              </p>
            )}
            {shared.length === 0 ? (
              <p className="text-muted-foreground text-xs italic">
                {t("integration.admin.orgDefault.noPinnableConnections")}
              </p>
            ) : modeLocked ? (
              <p className="text-muted-foreground text-xs" data-testid="org-default-mode-locked">
                {t("integration.admin.orgDefault.pickBeforeMode")}
              </p>
            ) : null}
            {shared.length > 0 && forcedLocked && (
              <p className="text-muted-foreground text-xs" data-testid="org-default-forced-locked">
                {t("integration.admin.orgDefault.forcedNeedsClosedPins", {
                  count: openPinAgents.length,
                  agents: openPinAgents.join(", "),
                })}
              </p>
            )}
          </div>
          {shared.length > 0 && mode !== "choice" ? (
            <div className="min-w-0">
              <p id="org-default-connections-label" className="mb-3 text-sm font-medium">
                {connectionsLabel}
              </p>
              <ConnectionCheckboxList
                idPrefix="org-default-pick"
                aria-labelledby="org-default-connections-label"
                connections={shared}
                value={connectionIds}
                onChange={(next) => void save(next, mode === "forced", mode)}
                unavailableIds={unavailableIds}
                disabled={isLoading || isError || pendingValue !== null}
              />
            </div>
          ) : null}
        </div>
      )}
      <SaveFeedback
        pending={pendingValue !== null}
        success={outcome === "success"}
        error={outcome === "error"}
      />
    </div>
  );
}
