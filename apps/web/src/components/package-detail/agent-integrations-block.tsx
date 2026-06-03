// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Loader2, Puzzle } from "lucide-react";
import {
  useIntegrations,
  useIntegrationDetail,
  useIntegrationConnections,
  useAgentsConsumingIntegration,
  type AgentIntegrationEntry,
  type IntegrationAuthStatus,
  type IntegrationConnection,
  type IntegrationManifestView,
} from "../../hooks/use-integrations";
import { InlineConnectButton } from "../integration-connect/inline-connect-button";
import { connectionDisplayLabel } from "../integration-connect/connection-label";
import { pickDefaultAuth } from "../integration-connect/pick-default-auth";
import { connectableAuthKeys } from "../integration-connect/connectable-auth-keys";
import { IntegrationConnectionPicker } from "../integration-connect/integration-connection-picker";
import { isIntegrationEntryActive } from "../integration-connect/integration-run-readiness";
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
 * manifest. One card per dependency, three states (OK / action-required /
 * not-connected), CTA jumps to the integration detail page where the actor
 * can connect / re-consent.
 *
 * Status derivation matches the backend gate (collectIntegrationDependencyErrors):
 *   ❌ not_connected         — no connection on any required auth
 *   ⚠️ needs_reconnection    — connection flagged for re-consent
 *   ✅ ok
 *
 * Per-tool scope inference (required = ⋃ tools.{t}.required_scopes for selected
 * tools, from the per-auth required_scopes map) is recomputed client-side so the badge
 * never lags the agent's editor state. The exact same logic powers the 412
 * server-side; the modal (Phase C) is the recovery path when this block is
 * stale or the actor hits Run before refreshing.
 *
 * AFPS §4.4 wildcard — when the agent declares `tools: "*"`, per-tool inference
 * is bypassed and scope requirements fall back to the selected auth's
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
    />
  );
}

/**
 * Connect CTA for surfaces WITHOUT the member picker — read-only previews
 * and agents that haven't selected any tool. Derives status from the
 * actor's own connections and surfaces a connect / reconnect / add-another
 * button plus the R5 reuse hint. Split from the picker path so its two
 * extra fetches (connections + consuming-agents) and the status/reuse
 * computation only run when actually rendered.
 */
function FallbackConnectCard({
  packageId,
  manifest,
  authStatuses,
  displayName,
  agentTools,
  agentScopes,
}: {
  packageId: string;
  manifest: IntegrationManifestView;
  authStatuses: IntegrationAuthStatus[];
  displayName: string;
  agentTools: string[] | "*" | undefined;
  agentScopes: string[] | undefined;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: connections, isPending: connsPending } = useIntegrationConnections(packageId);
  const { data: consumingAgents } = useAgentsConsumingIntegration(packageId);

  if (connsPending) {
    return (
      <CardShell
        icon={<Loader2 className="text-muted-foreground size-4 animate-spin" />}
        title={displayName}
        subtitle={packageId}
      />
    );
  }

  const status = deriveIntegrationStatus({
    manifest,
    connections: connections ?? [],
    agentTools,
    agentScopes,
  });
  const action = resolveAction(status, manifest, agentTools, agentScopes);

  // The connected connection drives the reuse hint below. We used to also
  // render an unlink button here, but it called the global delete endpoint
  // (DELETE /api/integrations/.../connections/:id) which yanked the connection
  // from every other agent in the app — the bug that drove this refactor.
  // The two safe paths are now: (a) change which connection THIS agent uses
  // via the picker (writes a member pin), or (b) delete the connection
  // globally from /connections (destructive, with confirm + impact list).
  const connectedAuthKey = status.kind === "ok" ? status.authKey : null;
  const connectedConnection = connectedAuthKey
    ? connections?.find((c) => c.auth_key === connectedAuthKey)
    : null;

  // R5 — reuse hint: surface that this single connection is shared across
  // every agent in the app that consumes this integration, killing the
  // "do I need one connection per agent?" confusion.
  const reuseInfo = connectedConnection
    ? buildReuseInfo(connectedConnection, consumingAgents?.length ?? 0, t)
    : null;

  // When already connected, still expose a path to add ANOTHER account on the
  // same auth — a user can hold multiple connections per integration and use
  // different ones across agents.
  const addAnotherAuthKey = status.kind === "ok" && status.authKey ? status.authKey : null;

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
          {...(action.intent !== "connect" && connectedConnection
            ? { connectionId: connectedConnection.id }
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
  connection: IntegrationConnection,
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
 * Map status → connect action. `not_connected` picks the first required
 * auth (preferring oauth2) so the user gets a one-click flow; if the
 * integration declares multiple auths the agent only needs ONE of them
 * resolved (mirrors the spawn resolver). `needs_reconnection` already
 * knows which authKey is at fault.
 */
function resolveAction(
  status: IntegrationStatus,
  manifest: IntegrationManifestView,
  agentTools: string[] | "*" | undefined,
  agentScopes: string[] | undefined,
): { authKey: string; scopes?: string[]; intent: "connect" | "reconnect" | "upgrade" } | null {
  if (status.kind === "ok") return null;
  // Both connect and reconnect must request the agent's inferred scopes — the
  // backend only adds manifest defaults for a plain connect, so the agent
  // surface forwards what THIS agent needs (the integration page connects at
  // defaults). Empty union (no tools/scopes picked) → omit, stay at defaults.
  const authKey =
    status.kind === "needs_reconnection" ? status.authKey : pickDefaultAuth(manifest.auths);
  if (!authKey) return null;
  const intent = status.kind === "needs_reconnection" ? "reconnect" : "connect";
  const scopes = requiredScopesForAgent({ manifest, authKey, agentTools, agentScopes });
  return { authKey, intent, ...(scopes.length ? { scopes } : {}) };
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

// ───────────────────────────────────────────────────────────────────────────
// Status derivation — mirrors apps/api/services/dependency-validation.ts
// (`checkOne`). Kept in lockstep so the badge and the 412 agree on what
// counts as "connected" at any moment.
// ───────────────────────────────────────────────────────────────────────────

type IntegrationStatus =
  | { kind: "ok"; authKey: string }
  | { kind: "not_connected" }
  | { kind: "needs_reconnection"; authKey: string };

function deriveIntegrationStatus(input: {
  manifest: IntegrationManifestView;
  connections: { auth_key: string; needs_reconnection: boolean }[];
  agentTools: string[] | "*" | undefined;
  agentScopes: string[] | undefined;
}): IntegrationStatus {
  const { manifest, connections, agentTools, agentScopes } = input;
  const auths = manifest.auths ?? {};
  if (Object.keys(auths).length === 0) return { kind: "ok", authKey: "" };

  // "Active" = the agent declared a usage: selected tools (MCP integrations)
  // or selected oauth scopes (apiCall integrations, which expose no discrete
  // tools). Nothing selected → integration is declared but inert; surface as
  // "ok" with empty authKey so the card doesn't render a "connect" CTA for an
  // unused integration. The picker is the place to opt in.
  if (!isIntegrationEntryActive({ tools: agentTools, scopes: agentScopes }))
    return { kind: "ok", authKey: "" };

  if (connections.length === 0) return { kind: "not_connected" };

  // Flat model: any accessible connection counts. Surface needs_reconnection
  // when ALL accessible connections need reconnect; otherwise pick the first
  // healthy one. The OAuth-scope check moved to the integration detail page
  // (passive — runtime selection is per-connection, the user may have picked
  // a different connection that doesn't need those scopes).
  const healthy = connections.find((c) => !c.needs_reconnection);
  if (healthy) {
    return { kind: "ok", authKey: healthy.auth_key };
  }
  return { kind: "needs_reconnection", authKey: connections[0]!.auth_key };
}
