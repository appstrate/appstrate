// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Puzzle } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { cn } from "@appstrate/ui/cn";
import {
  useIntegrationDetails,
  useIntegrationReadinessEntry,
  useAgentsConsumingIntegration,
  type AgentIntegrationEntry,
  type IntegrationCandidate,
  type IntegrationDetailWire,
} from "../../hooks/use-integrations";
import { usePermissions } from "../../hooks/use-permissions";
import { ActivateIntegrationButton } from "../activate-integration-button";
import { ApiError } from "../../api/errors";
import { errorMessage } from "../../lib/mutation-error";
import type { ConnectionSet } from "../../lib/connection-set";
import { ItemList } from "../item-list";
import { TableRowActions } from "../table-row-actions";
import { usePinEditor } from "../integration-detail/use-pin-editor";
import { pinRowActions } from "./pin-row-actions";
import { IntegrationConnectionPicker } from "../integration-connect/integration-connection-picker";
import {
  describeResolution,
  requiredNoneLabel,
  unboundLabel,
  UNBOUND_LABEL_KEYS,
} from "../integration-connect/integration-run-readiness";
import { AMBER_TEXT } from "../integration-connect/connection-picker-states";
import { Skeleton } from "@appstrate/ui/components/skeleton";

interface AgentIntegrationsBlockProps {
  /** The agent's declared integrations; the Connexions tab renders its own empty state. */
  entries: AgentIntegrationEntry[];
  /** The agent whose resolution each row reads and whose member pin its picker writes. */
  agentPackageId: string;
  /** The rows for a schedule: "Compte utilisé" picks the connections frozen on it (`connection_overrides`) instead of the member's pin, and the readiness column and the admin's menu go. */
  scheduleOverrides?: ScheduleOverrides;
}

interface ScheduleOverrides {
  /** The stored picks: a missing integration inherits, an empty set binds none (under an imposed set: adds none). */
  value: Readonly<Record<string, string[]>>;
  onChange: (integrationId: string, connectionIds: ConnectionSet) => void;
  version?: string;
}

/** An integration's own detail read, as one row needs it. */
interface DetailState {
  detail: IntegrationDetailWire | undefined;
  isLoading: boolean;
  error: unknown;
}

/** One declared integration and its own detail read. */
interface IntegrationRow {
  entry: AgentIntegrationEntry;
  state: DetailState;
}

/** 404: the integration is not placed in this space, which is what activating it fixes. */
const isNotPlaced = (error: unknown) => error instanceof ApiError && error.status === 404;

const displayNameOf = ({ entry, state }: IntegrationRow) =>
  state.detail?.manifest.display_name ?? entry.id;

/**
 * Connection status for every declared integration, driven by the server's
 * `IntegrationAgentResolution` from the bulk `connection-readiness` query (the same verdict as the
 * launch badge and the run-kickoff 409). The picker shows for every integration, even inert ones;
 * whether one BLOCKS the run is the server's `run_blocking` flag. Activity comes from the
 * integration's own detail, never the paginated list.
 *
 * One self-contained block per integration, stacked, so a phone keeps every part without
 * scrolling: name, id and access on the left, status and the admin's « … » on the right (the pin
 * of the integration for this agent, `integrations:configure` only and only once the integration
 * is active in the space, edited in the same dialogs as the integration page's pins table), and
 * the connections cell under them at full width.
 */
export function AgentIntegrationsBlock({
  entries,
  agentPackageId,
  scheduleOverrides,
}: AgentIntegrationsBlockProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const { can } = usePermissions();
  const details = useIntegrationDetails(entries.map((entry) => entry.id));
  // A pin binds the agent, whatever a schedule overrides: its rows offer none.
  const canPin = !scheduleOverrides && can("integrations:configure");

  const rows: IntegrationRow[] = entries.map((entry, index) => {
    const query = details[index]!;
    return {
      entry,
      state: { detail: query.data, isLoading: query.isLoading, error: query.error },
    };
  });

  return (
    <section aria-label={t("detail.connectionsTable.label")}>
      <ItemList
        items={rows}
        itemKey={(row) => row.entry.id}
        renderItem={(row) => (
          <div
            className="bg-card rounded-lg border p-3"
            data-testid={`integration-row-${row.entry.id}`}
          >
            <div className="flex items-start gap-2">
              <IntegrationIdentity
                packageId={row.entry.id}
                displayName={displayNameOf(row)}
                required={row.entry.required === true}
                state={row.state}
              />
              <div className="flex shrink-0 items-center gap-1">
                {!scheduleOverrides && (
                  <IntegrationStatusCell
                    packageId={row.entry.id}
                    // Optimistic while the detail loads so the status does not flash inactive.
                    spaceActive={
                      row.state.detail ? row.state.detail.active : !isNotPlaced(row.state.error)
                    }
                    agentPackageId={agentPackageId}
                  />
                )}
                {/* A pin binds an integration placed in the space: none to write for an inactive one. */}
                {canPin && row.state.detail?.active === true && (
                  <IntegrationPinActions
                    integrationId={row.entry.id}
                    integrationName={displayNameOf(row)}
                    agentPackageId={agentPackageId}
                  />
                )}
              </div>
            </div>
            <div className="mt-3 min-w-0">
              <p className="text-muted-foreground mb-1 text-xs">
                {t("detail.connectionsTable.account")}
              </p>
              <IntegrationConnectionCell
                entry={row.entry}
                state={row.state}
                agentPackageId={agentPackageId}
                scheduleOverrides={scheduleOverrides}
              />
            </div>
          </div>
        )}
      />
    </section>
  );
}

/**
 * The admin pin of one integration for this agent, in the row's « … », through the integration
 * page's own form and confirmation. Nothing until the pins and the agents using the integration
 * are read.
 */
function IntegrationPinActions({
  integrationId,
  integrationName,
  agentPackageId,
}: {
  integrationId: string;
  integrationName: string;
  agentPackageId: string;
}) {
  const { t } = useTranslation("agents");
  const editor = usePinEditor(integrationId);
  if (!editor.pins || !editor.consumingAgents) return null;
  const pin = editor.pins.find((p) => p.agent_package_id === agentPackageId);
  return (
    <>
      <TableRowActions
        menuLabel={t("detail.connectionsTable.rowActions", { integration: integrationName })}
        isPending={pin ? editor.isDeleting(pin) : false}
        actions={pinRowActions({
          t,
          integrationId,
          agentPackageId,
          pin,
          agentActive: editor.consumingAgents.some((a) => a.agent_package_id === agentPackageId),
          editor,
        })}
      />
      {editor.dialogs}
    </>
  );
}

function IntegrationConnectionCell({
  entry,
  state,
  agentPackageId,
  scheduleOverrides,
}: {
  /** The agent's dependency; its `required` flag decides whether an inactive one refuses the run. */
  entry: AgentIntegrationEntry;
  state: DetailState;
  agentPackageId: string;
  scheduleOverrides?: ScheduleOverrides;
}) {
  const { detail, isLoading, error } = state;
  const packageId = entry.id;
  const required = entry.required === true;

  if (!detail) {
    // A placeholder only while a fetch is in flight: a disabled read (no `integrations:read`) never settles.
    // The picker's own wait (`LoadingPicker`), so the cell keeps one shape.
    if (isLoading) return <Skeleton className="h-7 w-32 rounded-md" />;
    if (isNotPlaced(error))
      return <InactiveIntegration packageId={packageId} required={required} />;
    // Any other failure is named; a disabled read has none to name.
    return error ? (
      <span className={cn(AMBER_TEXT, "text-xs break-words")}>{errorMessage(error)}</span>
    ) : (
      <span className="text-muted-foreground text-sm">—</span>
    );
  }

  // Not active here: a disabled, explanatory control rather than a picker the run gate would reject.
  if (!detail.active) return <InactiveIntegration packageId={packageId} required={required} />;

  if (scheduleOverrides) {
    return (
      <IntegrationConnectionPicker
        integration={entry}
        agentPackageId={agentPackageId}
        persistence={{
          mode: "override",
          value: scheduleOverrides.value[packageId] ?? null,
          onChange: (ids) => scheduleOverrides.onChange(packageId, ids),
        }}
        version={scheduleOverrides.version}
      />
    );
  }

  return <ManagedIntegration entry={entry} agentPackageId={agentPackageId} />;
}

/** Split from the parent so its reads run only once the loading / not-active guards have passed. */
function ManagedIntegration({
  entry: integration,
  agentPackageId,
}: {
  entry: AgentIntegrationEntry;
  agentPackageId: string;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const packageId = integration.id;
  const { data: entry } = useIntegrationReadinessEntry(packageId, agentPackageId);
  const resolution = entry?.resolution;
  const { data: consumingAgents } = useAgentsConsumingIntegration(packageId);

  // The verdict can know it is off when the detail did not; an `inactive` verdict is a warning,
  // so the run starts without it.
  if (resolution?.warning?.code === "integration_not_active") {
    return <InactiveIntegration packageId={packageId} required={false} />;
  }
  // AFPS §7.2: an integration declaring no auths binds no connection, there is nothing to pick.
  if (entry?.connection_required === false) {
    return (
      <span className="text-muted-foreground text-sm" data-testid="integration-no-connection">
        {t("integration.auth.none", { ns: "settings" })}
      </span>
    );
  }

  // Reuse hint, only when resolved: a blocking state is the picker's warning, not a reassuring line.
  const resolvedConnections =
    resolution?.resolved_connection_ids
      .map((id) => resolution.candidates.find((c) => c.id === id))
      .filter((c): c is IntegrationCandidate => !!c) ?? [];
  const reuseInfo =
    resolution && describeResolution(resolution).resolved
      ? buildReuseInfo(resolvedConnections, consumingAgents?.length ?? 0, t)
      : null;
  // A stored none on a required integration refuses the run; on an optional one it is a warning.
  const requiredNone = resolution ? requiredNoneLabel(resolution) : null;
  const note = requiredNone ?? unboundLabel(resolution?.warning ?? null) ?? reuseInfo;

  return (
    <div className="min-w-0">
      <IntegrationConnectionPicker integration={integration} agentPackageId={agentPackageId} />
      {note && (
        <p
          className={cn(
            requiredNone ? AMBER_TEXT : "text-muted-foreground",
            "mt-1 text-xs break-words",
          )}
        >
          {note}
        </p>
      )}
    </div>
  );
}

/** Switched off in this space: the reason and the activation button. Only a required one blocks. */
function InactiveIntegration({ packageId, required }: { packageId: string; required: boolean }) {
  const { t } = useTranslation(["agents"]);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <span
        className={cn(required ? "text-destructive" : "text-muted-foreground", "min-w-0 text-xs")}
        data-testid={`integration-inactive-${packageId}`}
      >
        {t(required ? "detail.integrationInactive" : UNBOUND_LABEL_KEYS.integration_not_active)}
      </span>
      <ActivateIntegrationButton packageId={packageId} />
    </span>
  );
}

function buildReuseInfo(
  connections: IntegrationCandidate[],
  agentCount: number,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  const account = connections.map((c) => c.label).join(" · ");
  if (agentCount <= 1) {
    return t("detail.integrationReuseSingle", { account, count: connections.length });
  }
  return t("detail.integrationReuseShared", { account, count: agentCount });
}

function IntegrationIdentity({
  packageId,
  displayName,
  required,
  state,
}: {
  packageId: string;
  displayName: string;
  required: boolean;
  state: DetailState;
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <Puzzle className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 truncate text-sm font-medium" title={displayName}>
          {displayName}
        </span>
        {required && (
          <Badge
            variant="secondary"
            className="shrink-0 text-[0.6rem]"
            data-testid={`integration-required-${packageId}`}
          >
            {t("detail.integrationRequiredBadge")}
          </Badge>
        )}
      </div>
      <div className="text-muted-foreground mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs">
        <span className="min-w-0 truncate font-mono" title={packageId}>
          {packageId}
        </span>
        <span aria-hidden>·</span>
        <IntegrationAccessCell state={state} />
      </div>
    </div>
  );
}

function IntegrationAccessCell({ state }: { state: DetailState }) {
  const { t } = useTranslation(["agents", "settings"]);
  const { detail, isLoading } = state;
  if (isLoading) return <Skeleton className="h-4 w-16" />;
  if (!detail) return <span className="text-muted-foreground text-xs">—</span>;
  const types = Array.from(
    new Set(Object.values(detail.manifest.auths ?? {}).map((auth) => auth.type)),
  );
  if (types.length === 0) {
    return (
      <span className="text-muted-foreground text-xs">{t("detail.connectionsTable.none")}</span>
    );
  }
  return (
    <span className="text-muted-foreground text-xs">
      {types.map((type) => t(`settings:integration.auth.type.${type}`)).join(", ")}
    </span>
  );
}

/**
 * Ready, to configure (the run is refused), or unbound (the run starts without it,
 * the picker's note says why).
 */
function IntegrationStatusCell({
  packageId,
  spaceActive,
  agentPackageId,
}: {
  packageId: string;
  spaceActive: boolean;
  agentPackageId: string;
}) {
  const { t } = useTranslation("agents");
  const { data: entry, isLoading } = useIntegrationReadinessEntry(packageId, agentPackageId);
  if (!spaceActive) {
    return <Badge variant="pending">{t("detail.connectionsTable.inactive")}</Badge>;
  }
  if (isLoading) {
    return <Badge variant="pending">{t("detail.connectionsTable.checking")}</Badge>;
  }
  // Settled without a verdict (a failed read, or none for this integration): no status to give,
  // and "checking" would never end.
  if (!entry) return <span className="text-muted-foreground text-xs">—</span>;
  if (!entry.connection_required || describeResolution(entry.resolution).resolved) {
    return <Badge variant="success">{t("detail.connectionsTable.ready")}</Badge>;
  }
  return entry.run_blocking ? (
    <Badge variant="warning">{t("detail.connectionsTable.required")}</Badge>
  ) : (
    <Badge variant="secondary">{t("detail.connectionsTable.unbound")}</Badge>
  );
}
