// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Puzzle } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { cn } from "@appstrate/ui/cn";
import {
  useIntegrationDetails,
  useIntegrationReadinessEntry,
  useAgentsConsumingIntegration,
  type AgentIntegrationEntry,
  type IntegrationAuthStatus,
  type IntegrationCandidate,
  type IntegrationDetailWire,
  type IntegrationManifestView,
} from "../../hooks/use-integrations";
import { useSetPackageActive } from "../../hooks/use-library";
import { ApiError } from "../../api/errors";
import { errorMessage } from "../../lib/mutation-error";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useCurrentSpaceGrant } from "../../hooks/use-permissions";
import { maySetPackageActive } from "../../lib/package-permissions";
import type { ConnectionSet } from "../../lib/connection-set";
import { IntegrationConnectionPicker } from "../integration-connect/integration-connection-picker";
import {
  describeResolution,
  requiredNoneLabel,
  unboundLabel,
  UNBOUND_LABEL_KEYS,
} from "../integration-connect/integration-run-readiness";
import { AMBER_TEXT } from "../integration-connect/connection-picker-states";
import { DataTable, type DataColumn } from "../data-table";
import { ListToolbar, type FilterSpec } from "../list-toolbar";

interface AgentIntegrationsBlockProps {
  entries: AgentIntegrationEntry[];
  /**
   * Agent package id — keys per-agent admin pins. Optional so callers
   * that don't surface the admin pin row (e.g. read-only previews) can
   * omit it; when present, an admin can pin a specific shared connection
   * for THIS agent on each (integration, authKey).
   */
  agentPackageId?: string;
  /**
   * The table for a schedule rather than the agent: "Compte utilisé" picks the
   * connections frozen on the schedule (`connection_overrides`, the launch
   * layer of every fire) instead of the member's pin, against the version the
   * schedule fires. The agent's readiness column says nothing of a schedule,
   * so it goes.
   */
  scheduleOverrides?: ScheduleOverrides;
}

interface ScheduleOverrides {
  /** The stored picks: a missing integration inherits, an empty set binds none. */
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

/**
 * Connection-status table for every integration declared in the agent
 * manifest. A row with a per-agent context (`agentPackageId`) renders the
 * per-integration connection picker — list, pick, disambiguate, connect,
 * reconnect, add-another — driven by the server-authoritative
 * `IntegrationAgentResolution`, selected from the bulk
 * `GET /api/agents/:scope/:name/connection-readiness` query — the same verdict
 * the launch-button readiness badge and the run-kickoff 409 consume, so the
 * three can never disagree.
 *
 * The picker renders for EVERY declared integration, independent of whether the
 * agent selected tools/scopes: connection management applies even to an inert
 * integration. Whether an integration BLOCKS the run (run semantics) is the
 * server's `run_blocking` flag on the same bulk query, not a client predicate.
 *
 * Whether an integration is active comes from its own detail, never from the
 * paginated list. A dependency binds 0..N connections and only a `required`
 * one refuses the run: an unbound optional one says why the run starts without it.
 */
export function AgentIntegrationsBlock({
  entries,
  agentPackageId,
  scheduleOverrides,
}: AgentIntegrationsBlockProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const [search, setSearch] = useState("");
  const [states, setStates] = useState<string[]>([]);
  const details = useIntegrationDetails(entries.map((entry) => entry.id));
  if (entries.length === 0) return null;

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const rows = entries
    .map((entry, index) => {
      const query = details[index]!;
      const state: DetailState = {
        detail: query.data,
        isLoading: query.isLoading,
        error: query.error,
      };
      return {
        entry,
        state,
        displayName: state.detail?.manifest.display_name ?? entry.id,
        // Optimistic while the detail loads so the table does not flash an inactive state.
        appActive: state.detail ? state.detail.active : !isNotPlaced(state.error),
      };
    })
    .filter((row) => {
      const state = row.appActive ? "active" : "inactive";
      const matchesState = states.length === 0 || states.includes(state);
      const matchesSearch =
        normalizedSearch === "" ||
        row.entry.id.toLocaleLowerCase().includes(normalizedSearch) ||
        row.displayName.toLocaleLowerCase().includes(normalizedSearch);
      return matchesState && matchesSearch;
    });
  type Row = (typeof rows)[number];
  const columns: DataColumn<Row>[] = [
    {
      id: "integration",
      header: t("detail.connectionsTable.integration"),
      width: "minmax(200px,1.2fr)",
      cell: ({ entry, displayName }) => (
        <IntegrationIdentityCell
          packageId={entry.id}
          displayName={displayName}
          required={entry.required === true}
        />
      ),
    },
    {
      id: "access",
      header: t("detail.connectionsTable.access"),
      width: "minmax(150px,0.8fr)",
      cell: ({ state }) => <IntegrationAccessCell state={state} />,
    },
    {
      id: "account",
      header: t("detail.connectionsTable.account"),
      width: "minmax(260px,1.4fr)",
      cell: ({ entry, state }) => (
        <IntegrationConnectionCell
          packageId={entry.id}
          state={state}
          agentTools={entry.tools}
          agentScopes={entry.scopes}
          required={entry.required === true}
          {...(agentPackageId ? { agentPackageId } : {})}
          {...(scheduleOverrides ? { scheduleOverrides } : {})}
        />
      ),
    },
  ];
  if (!scheduleOverrides)
    columns.push({
      id: "status",
      header: t("detail.connectionsTable.status"),
      width: "130px",
      cell: ({ entry, appActive }) => (
        <IntegrationStatusCell
          packageId={entry.id}
          appActive={appActive}
          agentPackageId={agentPackageId}
        />
      ),
    });
  const filters: FilterSpec[] = [
    {
      id: "activation",
      label: t("detail.connectionsTable.filterActivation"),
      values: states,
      options: [
        { value: "active", label: t("detail.connectionsTable.active") },
        { value: "inactive", label: t("detail.connectionsTable.inactive") },
      ],
      onChange: setStates,
    },
  ];

  return (
    <>
      <ListToolbar
        placement="panel"
        panelFiltersAdjacent
        search={{
          value: search,
          onChange: setSearch,
          placeholder: t("detail.connectionsTable.search"),
        }}
        filters={filters}
        onReset={() => {
          setSearch("");
          setStates([]);
        }}
      />
      <DataTable
        label={t("detail.connectionsTable.label")}
        columns={columns}
        columnMode="scroll"
        surface="integrated"
        rows={rows}
        rowKey={({ entry }) => entry.id}
        empty={
          <p className="text-muted-foreground px-3 py-6 text-sm">
            {t("detail.connectionsTable.noMatch")}
          </p>
        }
      />
    </>
  );
}

function IntegrationConnectionCell({
  packageId,
  state,
  agentTools,
  agentScopes,
  required,
  agentPackageId,
  scheduleOverrides,
}: {
  packageId: string;
  state: DetailState;
  agentTools: string[] | "*" | undefined;
  agentScopes: string[] | undefined;
  /** The agent's `required` flag: an inactive required integration refuses the run. */
  required: boolean;
  agentPackageId?: string;
  scheduleOverrides?: ScheduleOverrides;
}) {
  const { detail, isLoading, error } = state;

  if (!detail) {
    // A spinner only while a fetch is in flight: a disabled read (no `integrations:read`) never settles.
    if (isLoading) return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
    if (isNotPlaced(error))
      return <InactiveIntegration packageId={packageId} required={required} />;
    // Any other failure is named; a disabled read has none to name.
    return error ? (
      <span className={cn(AMBER_TEXT, "text-xs break-words")}>{errorMessage(error)}</span>
    ) : (
      <span className="text-muted-foreground text-sm">—</span>
    );
  }

  // Not active in this space (the integration's own detail says so) → no
  // connection is possible. Show a disabled, explanatory control rather than a
  // picker the run-time gate would reject with `integration_not_active`.
  if (!detail.active) return <InactiveIntegration packageId={packageId} required={required} />;

  // Read-only preview (no per-agent context) — no picker/CTA.
  // Matches the prior behaviour for library/marketplace previews.
  if (!agentPackageId) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }

  if (scheduleOverrides) {
    return (
      <IntegrationConnectionPicker
        integrationId={packageId}
        agentPackageId={agentPackageId}
        manifest={detail.manifest}
        authStatuses={detail.auths}
        agentTools={agentTools}
        agentScopes={agentScopes}
        persistence={{
          mode: "override",
          value: scheduleOverrides.value[packageId] ?? null,
          onChange: (ids) => scheduleOverrides.onChange(packageId, ids),
        }}
        version={scheduleOverrides.version}
      />
    );
  }

  return (
    <ManagedIntegration
      packageId={packageId}
      agentPackageId={agentPackageId}
      manifest={detail.manifest}
      authStatuses={detail.auths}
      agentTools={agentTools}
      agentScopes={agentScopes}
    />
  );
}

/**
 * Connection-management surface for an active integration on a specific agent.
 * Split from the parent so its data fetches (resolution + consuming-agents) run
 * only once the parent's loading / not-active / read-only guards have passed —
 * i.e. only when the picker actually renders.
 */
function ManagedIntegration({
  packageId,
  agentPackageId,
  manifest,
  authStatuses,
  agentTools,
  agentScopes,
}: {
  packageId: string;
  agentPackageId: string;
  manifest: IntegrationManifestView;
  authStatuses: IntegrationAuthStatus[];
  agentTools: string[] | "*" | undefined;
  agentScopes: string[] | undefined;
}) {
  const { t } = useTranslation(["agents"]);
  const { data: entry } = useIntegrationReadinessEntry(packageId, agentPackageId);
  const resolution = entry?.resolution;
  const { data: consumingAgents } = useAgentsConsumingIntegration(packageId);

  // The verdict can know it is off when the detail did not; an `inactive` verdict is a warning,
  // so the run starts without it.
  if (resolution?.warning?.code === "integration_not_active") {
    return <InactiveIntegration packageId={packageId} required={false} />;
  }

  // R5 — reuse hint: the resolved connections are shared across every agent in
  // the space that consumes this integration, killing the "do I need one
  // connection per agent?" confusion. Only when resolved AND not blocking — a
  // blocking state is the picker's warning foreground, not a reassuring line.
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
      <IntegrationConnectionPicker
        integrationId={packageId}
        agentPackageId={agentPackageId}
        manifest={manifest}
        authStatuses={authStatuses}
        agentTools={agentTools}
        agentScopes={agentScopes}
      />
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
  const { t } = useTranslation(["agents", "common"]);
  const setActive = useSetPackageActive();
  const currentSpaceId = useCurrentSpaceId();
  // The tree's ONE activation verdict (`maySetPackageActive`), not a third
  // spelling: the type's grant in THIS space, or owning it (RBAC §3.6).
  const spaceGrant = useCurrentSpaceGrant();
  const canActivate = maySetPackageActive(spaceGrant, "integration", true);

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
      {/* The sentence asks for an activation; without this the reader had to
          go find the integration page to perform it. Somebody the route
          would refuse gets the button DEAD with the reason on it, rather
          than a click that ends in a toast. */}
      <Button
        variant="outline"
        size="sm"
        disabled={setActive.isPending || !currentSpaceId || !canActivate}
        title={canActivate ? undefined : t("library.cannotActivate", { ns: "common" })}
        onClick={() => {
          if (!currentSpaceId || !canActivate) return;
          setActive.mutate({ spaceId: currentSpaceId, packageId, active: true });
        }}
        data-testid={`integration-activate-${packageId}`}
      >
        {setActive.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          t("editor.activateIntegration")
        )}
      </Button>
    </span>
  );
}

function buildReuseInfo(
  connections: IntegrationCandidate[],
  agentCount: number,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  // `label` is the connection's display name (identity or "Connexion N"),
  // always set at creation.
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
  if (isLoading) return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
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
  appActive,
  agentPackageId,
}: {
  packageId: string;
  appActive: boolean;
  agentPackageId?: string;
}) {
  const { t } = useTranslation("agents");
  const { data: entry, isPending } = useIntegrationReadinessEntry(packageId, agentPackageId);
  if (!appActive) {
    return <Badge variant="pending">{t("detail.connectionsTable.inactive")}</Badge>;
  }
  if (!agentPackageId || isPending || !entry) {
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
