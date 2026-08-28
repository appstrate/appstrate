// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Puzzle } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import {
  useActivateIntegration,
  useIntegrations,
  useIntegrationDetail,
  useIntegrationAgentResolution,
  useAgentsConsumingIntegration,
  type AgentIntegrationEntry,
  type IntegrationAuthStatus,
  type IntegrationCandidate,
  type IntegrationManifestView,
} from "../../hooks/use-integrations";
import { connectionDisplayLabel } from "../integration-connect/connection-label";
import { IntegrationConnectionPicker } from "../integration-connect/integration-connection-picker";
import { resolutionBlocksRun } from "../integration-connect/integration-run-readiness";
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
}

/**
 * Connection-status block for every integration declared in the agent
 * manifest. One card per dependency. A card with a per-agent context
 * (`agentPackageId`) renders the per-integration connection picker — list,
 * pick, disambiguate, connect, reconnect, upgrade, add-another — driven by the
 * server-authoritative `IntegrationAgentResolution`, selected from the bulk
 * `GET /api/agents/:scope/:name/connection-readiness` query — the same verdict
 * the launch-button readiness badge and the run-kickoff 412 consume, so the
 * three can never disagree.
 *
 * The picker renders for EVERY declared integration, independent of whether the
 * agent selected tools/scopes: connection management applies even to an inert
 * integration. Whether an integration BLOCKS the run (run semantics) is the
 * server's `run_blocking` flag on the same bulk query, not a client predicate.
 */
export function AgentIntegrationsBlock({ entries, agentPackageId }: AgentIntegrationsBlockProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const [search, setSearch] = useState("");
  const [states, setStates] = useState<string[]>([]);
  // The list carries `active` (installed + enabled in this app). An agent can
  // declare an integration that was never activated here (or got disabled);
  // those cards render a read-only "not active" state instead of a connect
  // affordance, mirroring the run-time `integration_not_active` gate.
  const { data: integrations } = useIntegrations();
  const activeIds = integrations
    ? new Set(integrations.filter((i) => i.active).map((i) => i.id))
    : null;

  if (entries.length === 0) return null;

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const rows = entries
    .map((entry) => {
      const summary = integrations?.find((integration) => integration.id === entry.id);
      return {
        entry,
        displayName: summary?.manifest.display_name ?? entry.id,
        // Optimistic while the list loads so the table does not flash an inactive state.
        appActive: activeIds ? activeIds.has(entry.id) : true,
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
      cell: ({ entry }) => <IntegrationIdentityCell packageId={entry.id} />,
    },
    {
      id: "access",
      header: t("detail.connectionsTable.access"),
      width: "minmax(150px,0.8fr)",
      cell: ({ entry }) => <IntegrationAccessCell packageId={entry.id} />,
    },
    {
      id: "account",
      header: t("detail.connectionsTable.account"),
      width: "minmax(260px,1.4fr)",
      cell: ({ entry, appActive }) => (
        <IntegrationConnectionCell
          packageId={entry.id}
          agentTools={entry.tools}
          agentScopes={entry.scopes}
          appActive={appActive}
          {...(agentPackageId ? { agentPackageId } : {})}
        />
      ),
    },
    {
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
    },
  ];
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

interface IntegrationConnectionCardProps {
  packageId: string;
  agentTools: string[] | "*" | undefined;
  agentScopes: string[] | undefined;
  /** Whether the integration is active (installed + enabled) in this app. */
  appActive: boolean;
  agentPackageId?: string;
}

function IntegrationConnectionCell({
  packageId,
  agentTools,
  agentScopes,
  appActive,
  agentPackageId,
}: IntegrationConnectionCardProps) {
  const { t } = useTranslation(["agents"]);
  const { data: detail, isPending: detailPending } = useIntegrationDetail(packageId);
  const activate = useActivateIntegration();

  if (detailPending || !detail) {
    return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
  }

  // Not active in this application → no connection is possible. Show a
  // disabled, explanatory control rather than a picker the run-time gate would
  // reject with `integration_not_active`.
  if (!appActive) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={activate.isPending}
        onClick={() => activate.mutate({ params: { path: { packageId } } })}
        data-testid={`integration-activate-${packageId}`}
      >
        {activate.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          t("editor.activateIntegration")
        )}
      </Button>
    );
  }

  // Read-only preview (no per-agent context) — just the shell, no picker/CTA.
  // Matches the prior behaviour for library/marketplace previews.
  if (!agentPackageId) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }

  return (
    <ManagedIntegrationCard
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
function ManagedIntegrationCard({
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
  const { data: resolution } = useIntegrationAgentResolution(packageId, agentPackageId);
  const { data: consumingAgents } = useAgentsConsumingIntegration(packageId);

  // R5 — reuse hint: the resolved connection is shared across every agent in
  // the app that consumes this integration, killing the "do I need one
  // connection per agent?" confusion. Only when resolved AND not blocking — a
  // blocking state is the picker's warning foreground, not a reassuring line.
  const resolvedConnection =
    resolution?.candidates.find((c) => c.id === resolution.resolved_connection_id) ?? null;
  const reuseInfo =
    resolution && resolvedConnection && !resolutionBlocksRun(resolution)
      ? buildReuseInfo(resolvedConnection, consumingAgents?.length ?? 0, t)
      : null;

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
      {reuseInfo && (
        <p className="text-muted-foreground mt-1 truncate text-xs" title={reuseInfo}>
          {reuseInfo}
        </p>
      )}
    </div>
  );
}

function buildReuseInfo(
  connection: IntegrationCandidate,
  agentCount: number,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  // `label` is the connection's display name (identity or "Connexion N"),
  // always set at creation.
  const account = connectionDisplayLabel(connection);
  if (agentCount <= 1) {
    return t("detail.integrationReuseSingle", { account });
  }
  return t("detail.integrationReuseShared", { account, count: agentCount });
}

function IntegrationIdentityCell({ packageId }: { packageId: string }) {
  const { data: detail, isPending } = useIntegrationDetail(packageId);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Puzzle className="text-muted-foreground size-4 shrink-0" />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">
          {isPending ? packageId : (detail?.manifest.display_name ?? packageId)}
        </div>
        <div className="text-muted-foreground truncate font-mono text-xs">{packageId}</div>
      </div>
    </div>
  );
}

function IntegrationAccessCell({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: detail, isPending } = useIntegrationDetail(packageId);
  if (isPending || !detail)
    return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
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
  const { data: resolution, isPending } = useIntegrationAgentResolution(packageId, agentPackageId);
  if (!appActive) {
    return <Badge variant="pending">{t("detail.connectionsTable.inactive")}</Badge>;
  }
  if (!agentPackageId || isPending || !resolution) {
    return <Badge variant="pending">{t("detail.connectionsTable.checking")}</Badge>;
  }
  return resolutionBlocksRun(resolution) ? (
    <Badge variant="warning">{t("detail.connectionsTable.required")}</Badge>
  ) : (
    <Badge variant="success">{t("detail.connectionsTable.ready")}</Badge>
  );
}
