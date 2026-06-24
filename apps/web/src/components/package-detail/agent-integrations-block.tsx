// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Loader2, Puzzle } from "lucide-react";
import {
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
 * server-authoritative `IntegrationAgentResolution`
 * (`GET /integrations/:id/agent-resolution/:agentId`), the same verdict the
 * launch-button readiness badge and the run-kickoff 412 consume, so the three
 * can never disagree.
 *
 * The picker renders for EVERY declared integration, independent of whether the
 * agent selected tools/scopes: the runtime activity gate
 * (`isIntegrationEntryActive`) belongs to the launch badge, not to connection
 * management — an inert integration still has connections to manage.
 */
export function AgentIntegrationsBlock({ entries, agentPackageId }: AgentIntegrationsBlockProps) {
  // The list carries `active` (installed + enabled in this app). An agent can
  // declare an integration that was never activated here (or got disabled);
  // those cards render a read-only "not active" state instead of a connect
  // affordance, mirroring the run-time `integration_not_active` gate.
  const { data: integrations } = useIntegrations();
  const activeIds = integrations
    ? new Set(integrations.filter((i) => i.active).map((i) => i.id))
    : null;

  if (entries.length === 0) return null;

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <IntegrationConnectionCard
          key={entry.id}
          packageId={entry.id}
          agentTools={entry.tools}
          agentScopes={entry.scopes}
          // Optimistic while the list loads (null) so the card doesn't flash
          // a "not active" state; once loaded, gate strictly on membership.
          appActive={activeIds ? activeIds.has(entry.id) : true}
          {...(agentPackageId ? { agentPackageId } : {})}
        />
      ))}
    </div>
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

function IntegrationConnectionCard({
  packageId,
  agentTools,
  agentScopes,
  appActive,
  agentPackageId,
}: IntegrationConnectionCardProps) {
  const { t } = useTranslation(["agents"]);
  const { data: detail, isPending: detailPending } = useIntegrationDetail(packageId);
  const displayName = detail?.manifest.display_name ?? packageId;

  if (detailPending || !detail) {
    return (
      <CardShell
        icon={<Loader2 className="text-muted-foreground size-4 animate-spin" />}
        title={displayName}
        subtitle={packageId}
      />
    );
  }

  // Not active in this application → no connection is possible. Show a
  // disabled, explanatory control rather than a picker the run-time gate would
  // reject with `integration_not_active`.
  if (!appActive) {
    return (
      <CardShell title={displayName} subtitle={packageId}>
        <span
          className="text-destructive max-w-[18rem] text-right text-xs"
          data-testid={`integration-inactive-${packageId}`}
        >
          {t("detail.integrationInactive")}
        </span>
      </CardShell>
    );
  }

  // Read-only preview (no per-agent context) — just the shell, no picker/CTA.
  // Matches the prior behaviour for library/marketplace previews.
  if (!agentPackageId) {
    return <CardShell title={displayName} subtitle={packageId} />;
  }

  return (
    <ManagedIntegrationCard
      packageId={packageId}
      agentPackageId={agentPackageId}
      manifest={detail.manifest}
      authStatuses={detail.auths}
      displayName={displayName}
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
  displayName,
  agentTools,
  agentScopes,
}: {
  packageId: string;
  agentPackageId: string;
  manifest: IntegrationManifestView;
  authStatuses: IntegrationAuthStatus[];
  displayName: string;
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
    <CardShell title={displayName} subtitle={packageId} extraSubtitle={reuseInfo}>
      <IntegrationConnectionPicker
        integrationId={packageId}
        agentPackageId={agentPackageId}
        manifest={manifest}
        authStatuses={authStatuses}
        displayName={displayName}
        agentTools={agentTools}
        agentScopes={agentScopes}
      />
    </CardShell>
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

function CardShell({
  icon,
  title,
  subtitle,
  extraSubtitle,
  children,
}: {
  /** Optional inline icon before the subtitle (e.g. loading spinner). */
  icon?: React.ReactNode;
  title: string;
  subtitle: string;
  /** Second-line subtitle (e.g. reuse hint). Omitted when null/undefined. */
  extraSubtitle?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-border bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Puzzle className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="text-muted-foreground flex items-center gap-1.5 truncate text-xs">
            {icon}
            <span className="truncate font-mono">{subtitle}</span>
          </div>
          {extraSubtitle && (
            <div className="text-muted-foreground/80 mt-0.5 truncate text-[0.65rem]">
              {extraSubtitle}
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
