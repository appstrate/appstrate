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
  type IntegrationAgentResolution,
  type IntegrationCandidate,
  type IntegrationManifestView,
} from "../../hooks/use-integrations";
import { InlineConnectButton } from "../integration-connect/inline-connect-button";
import { connectionDisplayLabel } from "../integration-connect/connection-label";
import { pickDefaultAuth } from "../integration-connect/pick-default-auth";
import { connectableAuthKeys } from "../integration-connect/connectable-auth-keys";
import { IntegrationConnectionPicker } from "../integration-connect/integration-connection-picker";
import {
  isIntegrationEntryActive,
  resolutionBlocksRun,
} from "../integration-connect/integration-run-readiness";
import { requiredScopesForAgent } from "@appstrate/core/integration";

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
 * manifest. One card per dependency, with a connect / reconnect / upgrade
 * affordance so the actor can connect or re-consent inline.
 *
 * Status comes from the server-authoritative `IntegrationAgentResolution`
 * (`GET /integrations/:id/agent-resolution/:agentId`) — the same verdict the
 * connection picker and the launch-button readiness badge consume. The card
 * never re-derives "is this connected?" client-side, so the badge, the picker,
 * and the run-kickoff 412 can never disagree.
 *
 * AFPS §4.4 wildcard — when the agent declares `tools: "*"`, per-tool scope
 * inference is bypassed and scope requirements fall back to the selected auth's
 * `default_scopes` (§7.4). The activity check + connection picker still treat
 * the wildcard as an active selection.
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
  // disabled, explanatory control rather than a picker/connect button that
  // the run-time gate would reject with `integration_not_active`.
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

  // Member pre-run picker — surfaces ambiguity (>1 candidates) BEFORE Run.
  // Admin pin management has moved to the integration detail page (R2);
  // this block now carries only member-facing widgets. The picker is
  // integration-level (flat model — one connection per integration,
  // regardless of auth shape).
  //
  // "Active" = the agent declared a usage for this integration. For MCP
  // integrations that's a tool selection; for apiCall integrations there
  // are no discrete tools — the usage is the selected oauth scopes. Gating
  // on tools alone made apiCall integrations structurally unconnectable
  // from the agent page.
  const isActive = isIntegrationEntryActive({ tools: agentTools, scopes: agentScopes });
  const showMemberPicker = !!agentPackageId && isActive;

  // The dropdown is the unified per-integration control — it lists every
  // accessible connection AND carries "add a connection" entries, so it
  // stands in for the connect/reconnect button. It owns its own data
  // (accessible connections + pins), so the fallback's status/reuse
  // computation and its extra fetches are skipped entirely here.
  if (showMemberPicker) {
    return (
      <CardShell title={displayName} subtitle={packageId}>
        <IntegrationConnectionPicker
          integrationId={packageId}
          agentPackageId={agentPackageId!}
          manifest={detail.manifest}
          authStatuses={detail.auths}
          displayName={displayName}
          agentTools={agentTools}
          agentScopes={agentScopes}
        />
      </CardShell>
    );
  }

  return (
    <FallbackConnectCard
      packageId={packageId}
      manifest={detail.manifest}
      authStatuses={detail.auths}
      displayName={displayName}
      agentTools={agentTools}
      agentScopes={agentScopes}
      {...(agentPackageId ? { agentPackageId } : {})}
    />
  );
}

/**
 * Connect CTA for surfaces WITHOUT the member picker — read-only previews
 * and agents that haven't selected any tool. Reads the server-authoritative
 * `IntegrationAgentResolution` (the same verdict the picker and the launch
 * readiness badge consume) and surfaces a connect / reconnect / upgrade /
 * add-another button plus the R5 reuse hint. Split from the picker path so
 * its extra fetches (resolution + consuming-agents) only run when actually
 * rendered.
 *
 * Without an `agentPackageId` (read-only preview) the resolution query is
 * disabled and there's no per-agent verdict to surface, so the card renders
 * the shell alone — no actionable CTA, matching the prior behaviour for that
 * read-only surface.
 */
function FallbackConnectCard({
  packageId,
  manifest,
  authStatuses,
  displayName,
  agentTools,
  agentScopes,
  agentPackageId,
}: {
  packageId: string;
  manifest: IntegrationManifestView;
  authStatuses: IntegrationAuthStatus[];
  displayName: string;
  agentTools: string[] | "*" | undefined;
  agentScopes: string[] | undefined;
  agentPackageId?: string;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: resolution, isPending: resolutionPending } = useIntegrationAgentResolution(
    packageId,
    agentPackageId,
  );
  const { data: consumingAgents } = useAgentsConsumingIntegration(packageId);

  // No agentPackageId → resolution is disabled (no per-agent verdict). Render
  // the shell alone; this is the read-only preview surface, which never
  // offered an actionable CTA.
  if (!agentPackageId) {
    return <CardShell title={displayName} subtitle={packageId} />;
  }

  if (resolutionPending || !resolution) {
    return (
      <CardShell
        icon={<Loader2 className="text-muted-foreground size-4 animate-spin" />}
        title={displayName}
        subtitle={packageId}
      />
    );
  }

  const action = resolveAction(resolution, manifest, agentTools, agentScopes);

  // The resolved connection drives the reuse hint below. We used to also
  // render an unlink button here, but it called the global delete endpoint
  // (DELETE /api/integrations/.../connections/:id) which yanked the connection
  // from every other agent in the app — the bug that drove this refactor.
  // The two safe paths are now: (a) change which connection THIS agent uses
  // via the picker (writes a member pin), or (b) delete the connection
  // globally from /connections (destructive, with confirm + impact list).
  const resolvedConnection =
    resolution.candidates.find((c) => c.id === resolution.resolved_connection_id) ?? null;

  // R5 — reuse hint: surface that this single connection is shared across
  // every agent in the app that consumes this integration, killing the
  // "do I need one connection per agent?" confusion. Only when the resolved
  // connection isn't itself blocking (no missing scopes / reconnection) — a
  // blocking action takes the foreground instead.
  const reuseInfo =
    resolvedConnection && !action
      ? buildReuseInfo(resolvedConnection, consumingAgents?.length ?? 0, t)
      : null;

  // When already connected (no blocking action), still expose a path to add
  // ANOTHER account on the same auth — a user can hold multiple connections
  // per integration and use different ones across agents.
  const addAnotherAuthKey = !action && resolvedConnection ? resolvedConnection.auth_key : null;

  // An oauth2 connect/reconnect needs an admin-registered OAuth client; the
  // server returns 403 otherwise. Surface the pointer instead of a button
  // doomed to fail — mirrors the integration detail page's gate.
  const connectable = connectableAuthKeys(manifest, authStatuses);
  const actionBlockedNoClient = !!action && !connectable.has(action.authKey);

  return (
    <CardShell title={displayName} subtitle={packageId} extraSubtitle={reuseInfo}>
      {actionBlockedNoClient ? (
        <span className="text-muted-foreground max-w-[18rem] text-right text-xs">
          {t("settings:integration.auth.noClientHint")}
        </span>
      ) : action ? (
        <InlineConnectButton
          packageId={packageId}
          authKey={action.authKey}
          scopes={action.scopes}
          intent={action.intent}
          // reconnect / upgrade target the existing row — without a
          // connectionId the callback would INSERT a duplicate.
          {...(action.intent !== "connect" && action.connectionId
            ? { connectionId: action.connectionId }
            : {})}
        />
      ) : (
        addAnotherAuthKey &&
        (() => {
          // Another account for the same auth still has to satisfy THIS
          // agent's tool scopes, so request them rather than manifest defaults.
          const scopes = requiredScopesForAgent({
            manifest,
            authKey: addAnotherAuthKey,
            agentTools,
            agentScopes,
          });
          return (
            <InlineConnectButton
              packageId={packageId}
              authKey={addAnotherAuthKey}
              intent="connect"
              label={t("detail.integrationAddAnother")}
              forceAccountSelect
              {...(scopes.length ? { scopes } : {})}
            />
          );
        })()
      )}
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

/**
 * Map the server resolution → connect action for the fallback card. Mirrors
 * `resolutionBlocksRun`'s blocking states, choosing the right intent + target:
 *
 *   - `resolved_missing_scopes` non-empty → `upgrade` the resolved connection
 *     (incremental consent for the missing scopes only).
 *   - `needs_reconnection` → `reconnect` the resolved connection.
 *   - `none` / `must_choose` / `stale` → `connect` a fresh connection on the
 *     default auth (preferring oauth2; mirrors the spawn resolver — the agent
 *     only needs ONE of the declared auths resolved).
 *   - `auto` / `pinned` / `admin_locked` with no missing scopes → null (OK).
 *
 * Connect/reconnect/upgrade all request the agent's inferred scopes — the
 * backend only adds manifest defaults for a plain connect, so the agent
 * surface forwards what THIS agent needs (the integration page connects at
 * defaults). Empty union (no tools/scopes picked) → omit, stay at defaults.
 */
function resolveAction(
  resolution: IntegrationAgentResolution,
  manifest: IntegrationManifestView,
  agentTools: string[] | "*" | undefined,
  agentScopes: string[] | undefined,
): {
  authKey: string;
  scopes?: string[];
  intent: "connect" | "reconnect" | "upgrade";
  connectionId?: string;
} | null {
  const resolvedConnection =
    resolution.candidates.find((c) => c.id === resolution.resolved_connection_id) ?? null;

  // Under-scoped resolved connection → incremental-consent upgrade on it.
  if (resolution.resolved_missing_scopes.length > 0 && resolvedConnection) {
    return {
      authKey: resolvedConnection.auth_key,
      intent: "upgrade",
      connectionId: resolvedConnection.id,
      scopes: resolution.resolved_missing_scopes,
    };
  }

  // Resolved connection flagged for re-consent → reconnect it in place.
  if (resolution.status === "needs_reconnection" && resolvedConnection) {
    const scopes = requiredScopesForAgent({
      manifest,
      authKey: resolvedConnection.auth_key,
      agentTools,
      agentScopes,
    });
    return {
      authKey: resolvedConnection.auth_key,
      intent: "reconnect",
      connectionId: resolvedConnection.id,
      ...(scopes.length ? { scopes } : {}),
    };
  }

  // Any remaining blocking state — none / must_choose / stale, OR a
  // needs_reconnection / missing-scopes resolution whose target connection is
  // absent from `candidates` (so the upgrade/reconnect branches above didn't
  // fire) — falls back to a fresh connect on the default auth. Keying this off
  // the same predicate the run badge uses keeps the CTA in lockstep with
  // resolutionBlocksRun: the card never goes silent while the badge blocks.
  if (resolutionBlocksRun(resolution)) {
    const authKey = pickDefaultAuth(manifest.auths);
    if (!authKey) return null;
    const scopes = requiredScopesForAgent({ manifest, authKey, agentTools, agentScopes });
    return { authKey, intent: "connect", ...(scopes.length ? { scopes } : {}) };
  }

  // auto / pinned / admin_locked, fully scoped → connected, no action.
  return null;
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
