// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
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
import { ActivateIntegrationButton } from "../activate-integration-button";
import { ApiError } from "../../api/errors";
import { errorMessage } from "../../lib/mutation-error";
import type { ConnectionSet } from "../../lib/connection-set";
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
  /** The rows for a schedule: "Compte utilisé" picks the connections frozen on it (`connection_overrides`) instead of the member's pin, and the readiness column goes. */
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

/** 404: the integration is not placed in this space, which is what activating it fixes. */
const isNotPlaced = (error: unknown) => error instanceof ApiError && error.status === 404;

const TRACKS = "md:grid-cols-[minmax(160px,1.2fr)_minmax(120px,0.8fr)_minmax(200px,1.4fr)]";
const TRACKS_WITH_STATUS =
  "md:grid-cols-[minmax(160px,1.2fr)_minmax(120px,0.8fr)_minmax(200px,1.4fr)_130px]";

/** A row's cell: its column name heads it on a phone, and is read out beside it everywhere else. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="text-muted-foreground mb-1 block text-xs md:sr-only">{label}</span>
      {children}
    </div>
  );
}

/**
 * Connection status for every declared integration, driven by the server's
 * `IntegrationAgentResolution` from the bulk `connection-readiness` query (the same verdict as the
 * launch badge and the run-kickoff 409). The picker shows for every integration, even inert ones;
 * whether one BLOCKS the run is the server's `run_blocking` flag. Activity comes from the
 * integration's own detail, never the paginated list.
 */
export function AgentIntegrationsBlock({
  entries,
  agentPackageId,
  scheduleOverrides,
}: AgentIntegrationsBlockProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const details = useIntegrationDetails(entries.map((entry) => entry.id));
  const tracks = scheduleOverrides ? TRACKS : TRACKS_WITH_STATUS;
  const rowClass = cn("flex flex-col gap-3 px-3 py-3 md:grid md:items-center md:gap-4", tracks);

  return (
    <ul aria-label={t("detail.connectionsTable.label")} className="divide-y rounded-lg border">
      <li
        aria-hidden
        className={cn(
          "text-muted-foreground hidden gap-4 px-3 py-2 text-xs font-medium md:grid",
          tracks,
        )}
      >
        <span>{t("detail.connectionsTable.integration")}</span>
        <span>{t("detail.connectionsTable.access")}</span>
        <span>{t("detail.connectionsTable.account")}</span>
        {!scheduleOverrides && <span>{t("detail.connectionsTable.status")}</span>}
      </li>
      {entries.map((entry, index) => {
        const query = details[index]!;
        const state: DetailState = {
          detail: query.data,
          isLoading: query.isLoading,
          error: query.error,
        };
        // Optimistic while the detail loads so the status does not flash inactive.
        const spaceActive = state.detail ? state.detail.active : !isNotPlaced(state.error);
        return (
          <li key={entry.id} className={rowClass}>
            <IntegrationIdentityCell
              packageId={entry.id}
              displayName={state.detail?.manifest.display_name ?? entry.id}
              required={entry.required === true}
            />
            <Cell label={t("detail.connectionsTable.access")}>
              <IntegrationAccessCell state={state} />
            </Cell>
            <Cell label={t("detail.connectionsTable.account")}>
              <IntegrationConnectionCell
                entry={entry}
                state={state}
                agentPackageId={agentPackageId}
                scheduleOverrides={scheduleOverrides}
              />
            </Cell>
            {!scheduleOverrides && (
              <Cell label={t("detail.connectionsTable.status")}>
                <IntegrationStatusCell
                  packageId={entry.id}
                  spaceActive={spaceActive}
                  agentPackageId={agentPackageId}
                />
              </Cell>
            )}
          </li>
        );
      })}
    </ul>
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
    if (isLoading) return <Skeleton className="h-4 w-28" />;
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
  const { t } = useTranslation(["agents"]);
  const packageId = integration.id;
  const { data: entry } = useIntegrationReadinessEntry(packageId, agentPackageId);
  const resolution = entry?.resolution;
  const { data: consumingAgents } = useAgentsConsumingIntegration(packageId);

  // The verdict can know it is off when the detail did not; an `inactive` verdict is a warning,
  // so the run starts without it.
  if (resolution?.warning?.code === "integration_not_active") {
    return <InactiveIntegration packageId={packageId} required={false} />;
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
    <span className="flex items-center justify-end gap-3">
      <span
        className={cn(
          required ? "text-destructive" : "text-muted-foreground",
          "max-w-[18rem] text-xs sm:text-right",
        )}
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

function IntegrationIdentityCell({
  packageId,
  displayName,
  required,
}: {
  packageId: string;
  displayName: string;
  required: boolean;
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Puzzle className="text-muted-foreground size-4 shrink-0" />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{displayName}</span>
          {required && (
            <Badge
              variant="secondary"
              className="text-[0.6rem]"
              data-testid={`integration-required-${packageId}`}
            >
              {t("detail.integrationRequiredBadge")}
            </Badge>
          )}
        </div>
        <div className="text-muted-foreground truncate font-mono text-xs">{packageId}</div>
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
  const { data: entry, isPending } = useIntegrationReadinessEntry(packageId, agentPackageId);
  if (!spaceActive) {
    return <Badge variant="pending">{t("detail.connectionsTable.inactive")}</Badge>;
  }
  if (isPending || !entry) {
    return <Badge variant="pending">{t("detail.connectionsTable.checking")}</Badge>;
  }
  if (describeResolution(entry.resolution).resolved) {
    return <Badge variant="success">{t("detail.connectionsTable.ready")}</Badge>;
  }
  return entry.run_blocking ? (
    <Badge variant="warning">{t("detail.connectionsTable.required")}</Badge>
  ) : (
    <Badge variant="secondary">{t("detail.connectionsTable.unbound")}</Badge>
  );
}
