// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Loader2,
  Puzzle,
  Users,
  Check,
  Plus,
  Lock,
  ChevronDown,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useIntegrations,
  useIntegrationDetail,
  useIntegrationConnections,
  useAccessibleIntegrationConnections,
  useAgentsConsumingIntegration,
  useIntegrationPins,
  type AccessibleIntegrationConnection,
  type IntegrationConnection,
  type IntegrationManifestView,
} from "../../hooks/use-integrations";
import {
  useMemberIntegrationPins,
  useUpsertMemberIntegrationPin,
  useDeleteMemberIntegrationPin,
} from "../../hooks/use-member-integration-pins";
import { useAuth } from "../../hooks/use-auth";
import { usePermissions } from "../../hooks/use-permissions";
import { InlineConnectButton } from "../integration-connect/inline-connect-button";
import { FieldsConnectModal } from "../integration-connect/fields-connect-modal";
import { useIntegrationOAuthPopup } from "../integration-connect/use-integration-oauth-popup";
import { pickDefaultAuth } from "../integration-connect/pick-default-auth";
import { scopesContributedByTools, expandGrantedScopes } from "@appstrate/core/integration";

interface AgentIntegrationEntry {
  id: string;
  version: string;
  tools?: string[];
  scopes?: string[];
}

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
 * Phase B.1 — connection-status block for every integration declared in the
 * agent manifest. Mirrors the provider block: one card per dependency, three
 * states (OK / action-required / not-connected), CTA jumps to the
 * integration detail page where the actor can connect / re-consent.
 *
 * Status derivation matches the backend gate (collectIntegrationDependencyErrors):
 *   ❌ not_connected         — no connection on any required auth
 *   ⚠️ needs_reconnection    — connection flagged for re-consent
 *   ⚠️ insufficient_scopes   — granted ⊉ required (oauth2 only)
 *   ✅ ok
 *
 * Per-tool scope inference (required = ⋃ tools.{t}.requiredScopes for selected
 * tools, filtered by requiredAuthKey) is recomputed client-side so the badge
 * never lags the agent's editor state. The exact same logic powers the 412
 * server-side; the modal (Phase C) is the recovery path when this block is
 * stale or the actor hits Run before refreshing.
 */
export function AgentIntegrationsBlock({ entries, agentPackageId }: AgentIntegrationsBlockProps) {
  if (entries.length === 0) return null;

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <IntegrationConnectionCard
          key={entry.id}
          packageId={entry.id}
          agentTools={entry.tools}
          {...(agentPackageId ? { agentPackageId } : {})}
        />
      ))}
    </div>
  );
}

interface IntegrationConnectionCardProps {
  packageId: string;
  agentTools: string[] | undefined;
  agentPackageId?: string;
}

function IntegrationConnectionCard({
  packageId,
  agentTools,
  agentPackageId,
}: IntegrationConnectionCardProps) {
  const { t } = useTranslation(["agents"]);
  const { data: detail, isPending: detailPending } = useIntegrationDetail(packageId);
  const { data: connections, isPending: connsPending } = useIntegrationConnections(packageId);
  const { data: consumingAgents } = useAgentsConsumingIntegration(packageId);

  const displayName = detail?.manifest.displayName ?? packageId;
  const isLoading = detailPending || connsPending;

  if (isLoading || !detail) {
    return (
      <CardShell
        icon={<Loader2 className="text-muted-foreground size-4 animate-spin" />}
        title={displayName}
        subtitle={packageId}
      />
    );
  }

  // Status is computed only to drive the fallback connect CTA on surfaces
  // without the dropdown picker (read-only previews / no tools selected).
  // It is NOT shown on the card: it derives from the actor's OWN
  // connections, so it would read "not connected" even when an admin's
  // shared+pinned connection resolves fine. The dropdown is the source of
  // truth for "which connection this agent uses".
  const status = deriveIntegrationStatus({
    manifest: detail.manifest,
    connections: connections ?? [],
    agentTools,
  });

  const action = resolveAction(status, detail.manifest);

  // The connected connection drives the reuse hint below. We used to also
  // render an unlink button here, but it called the global delete endpoint
  // (DELETE /api/integrations/.../connections/:id) which yanked the connection
  // from every other agent in the app — the bug that drove this refactor.
  // The two safe paths are now: (a) change which connection THIS agent uses
  // via the picker below (writes a member pin), or (b) delete the connection
  // globally from /connections (destructive, with confirm + impact list).
  const connectedAuthKey = status.kind === "ok" ? status.authKey : null;
  const connectedConnection = connectedAuthKey
    ? connections?.find((c) => c.authKey === connectedAuthKey)
    : null;

  // R5 — reuse hint: surface that this single connection is shared across
  // every agent in the app that consumes this integration, killing the
  // "do I need one connection per agent?" confusion.
  const reuseInfo = connectedConnection
    ? buildReuseInfo(connectedConnection, consumingAgents?.length ?? 0, t)
    : null;

  // Member pre-run picker — surfaces ambiguity (>1 candidates) BEFORE Run.
  // Admin pin management has moved to the integration detail page (R2);
  // this block now carries only member-facing widgets. The picker is
  // integration-level (flat model — one connection per integration,
  // regardless of auth shape).
  const hasSelectedTools = (agentTools?.length ?? 0) > 0;
  const showMemberPicker = !!agentPackageId && hasSelectedTools;

  // When already connected, still expose a path to add ANOTHER account on the
  // same auth — a user can hold multiple connections per integration and use
  // different ones across agents. Without this CTA the only entry-point would
  // be an OAuth/upgrade flow, which doesn't fire when the existing connection
  // already satisfies the agent's needs.
  const addAnotherAuthKey = status.kind === "ok" && status.authKey ? status.authKey : null;

  return (
    <CardShell
      title={displayName}
      subtitle={packageId}
      extraSubtitle={showMemberPicker ? null : reuseInfo}
    >
      {showMemberPicker ? (
        // The dropdown is the unified per-integration control — it lists
        // every accessible connection AND carries "add a connection"
        // entries, so it stands in for the connect/reconnect button.
        <MemberConnectionPicker
          integrationPackageId={packageId}
          agentPackageId={agentPackageId!}
          manifest={detail.manifest}
          displayName={displayName}
          agentTools={agentTools}
        />
      ) : action ? (
        // Fallback for surfaces without the picker (read-only previews,
        // no tools selected): keep the explicit connect/reconnect CTA.
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
        addAnotherAuthKey && (
          <InlineConnectButton
            packageId={packageId}
            authKey={addAnotherAuthKey}
            intent="connect"
            label={t("detail.integrationAddAnother")}
            forceAccountSelect
          />
        )
      )}
    </CardShell>
  );
}

function buildReuseInfo(
  connection: IntegrationConnection,
  agentCount: number,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  const account =
    (connection.identityClaims?.accountEmail as string | undefined) ??
    (connection.identityClaims?.account_email as string | undefined) ??
    connection.label ??
    connection.accountId;
  if (agentCount <= 1) {
    return t("detail.integrationReuseSingle", { account });
  }
  return t("detail.integrationReuseShared", { account, count: agentCount });
}

/**
 * Per-integration connection picker for the member, rendered as a rich
 * dropdown. Lists every accessible connection (own + shared-with-org)
 * with its name, auth type (OAuth / API key …), and who created it, plus
 * an "auto" entry (defer to the resolver) and "add a connection" entries
 * (one per declared auth) that launch the connect flow inline.
 *
 * Picks are persisted as `integration_pins` rows with `user_id` set —
 * the resolver sees them at cascade layer 4 on every run. Admin pins
 * (`user_id IS NULL`) at layer 1 lock the choice for everyone: when an
 * admin pin exists for this (agent, integration), the dropdown is
 * disabled and shows the pinned connection with a lock badge.
 */
function MemberConnectionPicker({
  integrationPackageId,
  agentPackageId,
  manifest,
  displayName,
  agentTools,
}: {
  integrationPackageId: string;
  agentPackageId: string;
  manifest: IntegrationManifestView;
  displayName: string;
  agentTools: string[] | undefined;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const { user } = useAuth();
  const { isAdmin } = usePermissions();
  const { data: integrations } = useIntegrations();
  const { data: adminPins } = useIntegrationPins(integrationPackageId);
  const { data: memberPins } = useMemberIntegrationPins(agentPackageId);
  const { data: accessible } = useAccessibleIntegrationConnections(integrationPackageId);
  const upsertPin = useUpsertMemberIntegrationPin();
  const deletePin = useDeleteMemberIntegrationPin();
  const { openPopup, isPending: oauthPending } = useIntegrationOAuthPopup();
  const qc = useQueryClient();
  const [fieldsAuthKey, setFieldsAuthKey] = useState<string | null>(null);

  // Personal-connection creation can be disabled per (app, integration) by
  // an admin. Members then can't add a connection (mirrors the server gate
  // `assertConnectionCreationAllowed`); admins/owners always can.
  const userConnectionsBlocked =
    integrations?.find((i) => i.id === integrationPackageId)?.blockUserConnections === true;
  const canAddConnection = isAdmin || !userConnectionsBlocked;

  const candidates = accessible ?? [];
  const auths = manifest.auths ?? {};
  const authKeys = Object.keys(auths);

  const ownerLabel = (c: AccessibleIntegrationConnection): string => {
    if (c.ownerUserId && user?.id && c.ownerUserId === user.id) {
      return t("detail.integrationMemberPicker.byYou");
    }
    if (c.ownerName) return c.ownerName;
    return t("detail.integrationMemberPicker.ownerUnknown");
  };
  const typeLabel = (authKey: string): string | null => {
    const type = auths[authKey]?.type;
    return type ? t(`settings:integration.auth.type.${type}`) : null;
  };

  // Scopes the agent's selected tools require that a given connection
  // lacks, on that connection's own auth. Mirrors the server resolver's
  // checkHealth scope check (scopesContributedByTools ∖ expandGranted).
  // Empty for api_key/basic auths (no scopes contributed).
  const isOwn = (c: AccessibleIntegrationConnection): boolean =>
    !!c.ownerUserId && !!user?.id && c.ownerUserId === user.id;
  const missingScopesFor = (c: AccessibleIntegrationConnection): string[] => {
    const required = scopesContributedByTools({ manifest, authKey: c.authKey, agentTools });
    if (required.length === 0) return [];
    // `scopesGranted` may be undefined when the cached connection predates
    // the API field — guard so expandGrantedScopes's spread doesn't throw.
    const granted = new Set(expandGrantedScopes(c.scopesGranted ?? [], manifest, c.authKey));
    return required.filter((s) => !granted.has(s));
  };

  // Admin pin → locked. Disabled trigger surfacing the forced connection.
  const adminPin = adminPins?.find(
    (p) => p.packageId === agentPackageId && p.integrationPackageId === integrationPackageId,
  );
  if (adminPin) {
    const pinned = candidates.find((c) => c.id === adminPin.connectionId);
    const label = pinned?.label ?? pinned?.accountId ?? adminPin.connectionId;
    return (
      <div data-testid={`member-picker-${integrationPackageId}`}>
        <Button
          variant="outline"
          size="sm"
          disabled
          className="h-7 justify-start gap-1.5 text-xs"
          data-testid={`member-pick-locked-${integrationPackageId}`}
        >
          <Lock className="size-3" />
          <span className="truncate">{label}</span>
          <Badge variant="secondary" className="ml-1 text-[0.6rem]">
            {t("detail.integrationMemberPicker.adminLocked")}
          </Badge>
        </Button>
      </div>
    );
  }

  const memberPin = memberPins?.find((p) => p.integrationPackageId === integrationPackageId);
  const current = memberPin?.connectionId ?? null;

  // Mirror the server resolver (integration-connection-resolver.resolveOne)
  // for the agent-page context: admin pin is handled above; run/schedule
  // overrides are per-run and don't apply to this preview. What's left:
  //   member pin → that connection
  //   no pin, 0 candidates → not_connected
  //   no pin, 1 candidate  → that one (fallback_auto)
  //   no pin, >1 candidates → must_choose (NO implicit default)
  // So we show the connection the next run would actually use, not an
  // abstract "automatic" label.
  const effective = ((): {
    kind: "pinned" | "auto" | "must_choose" | "none" | "stale";
    conn?: AccessibleIntegrationConnection;
  } => {
    if (current) {
      const conn = candidates.find((c) => c.id === current);
      return conn ? { kind: "pinned", conn } : { kind: "stale" };
    }
    if (candidates.length === 0) return { kind: "none" };
    if (candidates.length === 1) return { kind: "auto", conn: candidates[0]! };
    return { kind: "must_choose" };
  })();
  // The connection the resolver would land on (pin or single fallback) —
  // drives the check mark + "(par défaut)" badge in the list.
  const effectiveConnId = effective.conn?.id ?? null;
  // Scope deficiency on the resolved connection blocks the run. Owner of
  // the connection can upgrade (incremental consent); otherwise it's a
  // read-only error (only the owner can re-consent).
  const effectiveMissing = effective.conn ? missingScopesFor(effective.conn) : [];
  const effectiveUnderScoped = effectiveMissing.length > 0;
  const effectiveOwn = effective.conn ? isOwn(effective.conn) : false;

  const triggerConnect = (authKey: string) => {
    const auth = auths[authKey];
    if (!auth) return;
    if (auth.type === "oauth2") {
      void openPopup({ packageId: integrationPackageId, authKey, forceAccountSelect: true });
    } else {
      setFieldsAuthKey(authKey);
    }
  };

  const hasCandidates = candidates.length > 0;
  const connName = (c: AccessibleIntegrationConnection) => c.label ?? c.accountId;
  const triggerLabel =
    effective.conn != null
      ? connName(effective.conn)
      : effective.kind === "must_choose"
        ? t("detail.integrationMemberPicker.chooseLabel")
        : effective.kind === "stale"
          ? t("detail.integrationMemberPicker.reconfigureLabel")
          : t("detail.integrationMemberPicker.connectLabel");
  // Warning visuals when there's no usable resolved connection OR the
  // resolved one is under-scoped (run would be blocked).
  const triggerWarn =
    effective.kind === "must_choose" || effective.kind === "stale" || effectiveUnderScoped;
  const TriggerIcon = triggerWarn ? AlertTriangle : effective.conn != null ? Users : Plus;
  const fieldsAuth = fieldsAuthKey ? auths[fieldsAuthKey] : null;

  // Blocked for this member AND nothing to pick → dead end. Show a
  // disabled, explanatory button instead of an empty dropdown.
  if (!canAddConnection && !hasCandidates) {
    return (
      <div data-testid={`member-picker-${integrationPackageId}`}>
        <Button
          variant="outline"
          size="sm"
          disabled
          className="h-7 justify-start gap-1.5 text-xs"
          data-testid={`member-pick-blocked-${integrationPackageId}`}
        >
          <Lock className="size-3" />
          <span className="truncate">{t("detail.integrationMemberPicker.blockedByAdmin")}</span>
        </Button>
      </div>
    );
  }

  return (
    <div data-testid={`member-picker-${integrationPackageId}`}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={`h-7 justify-start gap-1.5 text-xs ${triggerWarn ? "text-amber-600 dark:text-amber-400" : ""}`}
            data-testid={`member-pick-${integrationPackageId}`}
          >
            <TriggerIcon className="size-3" />
            <span className="max-w-[14rem] truncate">{triggerLabel}</span>
            {effective.kind === "auto" && (
              <span className="text-muted-foreground/70">
                {t("detail.integrationMemberPicker.defaultBadge")}
              </span>
            )}
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[20rem]">
          <DropdownMenuLabel className="text-[0.7rem]">
            {t("detail.integrationMemberPicker.title")}
          </DropdownMenuLabel>
          {candidates.map((c) => {
            const tl = typeLabel(c.authKey);
            const isDefault = !current && effectiveConnId === c.id;
            const missing = missingScopesFor(c);
            return (
              <DropdownMenuItem
                key={c.id}
                onSelect={() =>
                  upsertPin.mutate({ agentPackageId, integrationPackageId, connectionId: c.id })
                }
                data-testid={`member-pick-option-${c.id}`}
              >
                <Check className={`size-3.5 ${effectiveConnId === c.id ? "" : "opacity-0"}`} />
                <div className="flex min-w-0 flex-col">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{connName(c)}</span>
                    {tl && (
                      <Badge variant="outline" className="text-[0.6rem]">
                        {tl}
                      </Badge>
                    )}
                    {c.sharedWithOrg && (
                      <Badge variant="secondary" className="text-[0.6rem]">
                        {t("detail.integrationMemberPicker.sharedBadge")}
                      </Badge>
                    )}
                    {missing.length > 0 && (
                      <Badge variant="destructive" className="text-[0.6rem]">
                        {t("detail.integrationMemberPicker.missingScopesBadge")}
                      </Badge>
                    )}
                    {isDefault && (
                      <span className="text-muted-foreground/70 text-[0.6rem]">
                        {t("detail.integrationMemberPicker.defaultBadge")}
                      </span>
                    )}
                  </div>
                  <span className="text-muted-foreground truncate text-[0.65rem]">
                    {t("detail.integrationMemberPicker.connectedBy", { owner: ownerLabel(c) })}
                    {c.needsReconnection &&
                      ` · ${t("detail.integrationMemberPicker.needsReconnection")}`}
                  </span>
                </div>
              </DropdownMenuItem>
            );
          })}
          {current && (
            <DropdownMenuItem
              onSelect={() => deletePin.mutate({ agentPackageId, integrationPackageId })}
              data-testid={`member-pick-reset-${integrationPackageId}`}
            >
              <Check className="size-3.5 opacity-0" />
              <span className="text-muted-foreground">
                {t("detail.integrationMemberPicker.resetToAuto")}
              </span>
            </DropdownMenuItem>
          )}
          {canAddConnection && hasCandidates && <DropdownMenuSeparator />}
          {canAddConnection &&
            authKeys.map((k) => {
              const tl = typeLabel(k);
              return (
                <DropdownMenuItem
                  key={`add-${k}`}
                  onSelect={() => triggerConnect(k)}
                  data-testid={`member-pick-add-${integrationPackageId}-${k}`}
                >
                  <Plus className="size-3.5" />
                  <span>
                    {authKeys.length > 1 && tl
                      ? t("detail.integrationMemberPicker.addVia", { label: tl })
                      : t("detail.integrationMemberPicker.addConnection")}
                  </span>
                </DropdownMenuItem>
              );
            })}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Resolved connection is under-scoped → the run is blocked
          server-side (insufficient_scopes). Owner can upgrade via
          incremental consent; a foreign owner can only be flagged. */}
      {effectiveUnderScoped && effective.conn && (
        <div
          className="mt-1.5 flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[0.7rem] text-amber-700 dark:text-amber-300"
          data-testid={`member-pick-scope-warning-${integrationPackageId}`}
        >
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="size-3 shrink-0" />
            <span>
              {effectiveOwn
                ? t("detail.integrationMemberPicker.missingScopesOwn")
                : t("detail.integrationMemberPicker.missingScopesForeign", {
                    owner: ownerLabel(effective.conn),
                  })}
            </span>
          </div>
          <span className="text-foreground/80 font-mono text-[0.65rem] break-words">
            {effectiveMissing.join(" ")}
          </span>
          {effectiveOwn && auths[effective.conn.authKey]?.type === "oauth2" && (
            <div>
              <Button
                size="sm"
                disabled={oauthPending}
                onClick={async () => {
                  await openPopup({
                    packageId: integrationPackageId,
                    authKey: effective.conn!.authKey,
                    scopes: effectiveMissing,
                    connectionId: effective.conn!.id,
                  });
                  // The OAuth callback updated the connection's granted
                  // scopes server-side; refetch so the badge clears
                  // instead of waiting for a window-focus refetch.
                  await qc.invalidateQueries({ queryKey: ["integrations"] });
                }}
                data-testid={`member-pick-upgrade-${integrationPackageId}`}
              >
                <RefreshCw className="mr-1 size-3" />
                {t("detail.integrationMemberPicker.upgradeButton")}
              </Button>
            </div>
          )}
        </div>
      )}
      {fieldsAuth && fieldsAuthKey && (
        <FieldsConnectModal
          open={true}
          onClose={() => setFieldsAuthKey(null)}
          packageId={integrationPackageId}
          authKey={fieldsAuthKey}
          auth={fieldsAuth}
          displayName={displayName}
        />
      )}
    </div>
  );
}

/**
 * Map status → connect action. `not_connected` picks the first required
 * auth (preferring oauth2) so the user gets a one-click flow; if the
 * integration declares multiple auths the agent only needs ONE of them
 * resolved (mirrors the spawn resolver). `needs_reconnection` and
 * `insufficient_scopes` already know which authKey is at fault.
 */
function resolveAction(
  status: IntegrationStatus,
  manifest: IntegrationManifestView,
): { authKey: string; scopes?: string[]; intent: "connect" | "reconnect" | "upgrade" } | null {
  if (status.kind === "ok") return null;
  if (status.kind === "needs_reconnection") {
    return { authKey: status.authKey, intent: "reconnect" };
  }
  // not_connected — pick first oauth2, falling back to first declared.
  const authKey = pickDefaultAuth(manifest.auths);
  return authKey ? { authKey, intent: "connect" } : null;
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
  connections: { authKey: string; scopesGranted: string[]; needsReconnection: boolean }[];
  agentTools: string[] | undefined;
}): IntegrationStatus {
  const { manifest, connections, agentTools } = input;
  const auths = manifest.auths ?? {};
  if (Object.keys(auths).length === 0) return { kind: "ok", authKey: "" };

  const hasSelectedTools = (agentTools?.length ?? 0) > 0;
  // No tools picked → integration is declared but inert; surface as
  // "ok" with empty authKey so the card doesn't render a "connect" CTA
  // for an unused integration. The picker is the place to opt in.
  if (!hasSelectedTools) return { kind: "ok", authKey: "" };

  if (connections.length === 0) return { kind: "not_connected" };

  // Flat model: any accessible connection counts. Surface needs_reconnection
  // when ALL accessible connections need reconnect; otherwise pick the first
  // healthy one. The OAuth-scope check moved to the integration detail page
  // (passive — runtime selection is per-connection, the user may have picked
  // a different connection that doesn't need those scopes).
  const healthy = connections.find((c) => !c.needsReconnection);
  if (healthy) {
    return { kind: "ok", authKey: healthy.authKey };
  }
  return { kind: "needs_reconnection", authKey: connections[0]!.authKey };

  // Single-auth-per-integration invariant (server-side gate in
  // saveIntegrationConnection) means `connected` has at most one entry
}
