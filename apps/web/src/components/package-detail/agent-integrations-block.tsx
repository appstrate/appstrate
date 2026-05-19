// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  Puzzle,
  Unlink,
  Pin,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useIntegrationDetail,
  useIntegrationConnections,
  useAccessibleIntegrationConnections,
  useDisconnectIntegration,
  useIntegrationPins,
  useUpsertIntegrationPin,
  useDeleteIntegrationPin,
  type AccessibleIntegrationConnection,
  type IntegrationConnection,
  type IntegrationManifestView,
} from "../../hooks/use-integrations";
import { usePermissions } from "../../hooks/use-permissions";
import { useCurrentApplicationId } from "../../hooks/use-current-application";
import { useAgentConnectionPicks } from "../../hooks/use-agent-connection-picks";
import { InlineConnectButton } from "../integration-connect/inline-connect-button";
import { pickDefaultAuth } from "../integration-connect/pick-default-auth";
import {
  expandGrantedScopes,
  requiredAuthKeysForAgent,
  scopesContributedByTools,
} from "@appstrate/core/integration";

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
  const disconnect = useDisconnectIntegration();

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

  const status = deriveIntegrationStatus({
    manifest: detail.manifest,
    connections: connections ?? [],
    agentTools,
  });

  const { icon, subtitle } = renderStatus(status, t);
  const action = resolveAction(status, detail.manifest);

  // When connected, the small unlink button lets the actor switch auth
  // (the server-side single-auth-per-integration invariant means a
  // re-connect via the alternate auth would otherwise 409). Finds the
  // connection row for the connected auth so we can pass its id to
  // useDisconnectIntegration.
  const connectedAuthKey = status.kind === "ok" ? status.authKey : null;
  const connectedConnection = connectedAuthKey
    ? connections?.find((c) => c.authKey === connectedAuthKey)
    : null;

  // Admin pin row — only when caller passes agentPackageId (admin
  // surface). Renders below the connect/disconnect surface so the
  // "force this connection for this agent" mechanism is discoverable
  // exactly where the agent's integration dependency is already shown.
  const requiredAuthKeys = requiredAuthKeysForAgent(detail.manifest, agentTools);
  const showPinAdmin = !!agentPackageId && requiredAuthKeys.length > 0;
  const showMemberPicker = !!agentPackageId && requiredAuthKeys.length > 0;

  return (
    <div className="space-y-2">
      <CardShell icon={icon} title={displayName} subtitle={subtitle}>
        {action && (
          <InlineConnectButton
            packageId={packageId}
            authKey={action.authKey}
            scopes={action.scopes}
            intent={action.intent}
          />
        )}
        {connectedConnection && (
          <Button
            size="icon"
            variant="ghost"
            title={t("detail.integrationDisconnect")}
            onClick={() => disconnect.mutate({ packageId, connectionId: connectedConnection.id })}
            disabled={disconnect.isPending}
            data-testid={`disconnect-${packageId}`}
          >
            <Unlink className="size-3" />
          </Button>
        )}
      </CardShell>
      {showMemberPicker && (
        <MemberConnectionPicker
          integrationPackageId={packageId}
          agentPackageId={agentPackageId!}
          requiredAuthKeys={requiredAuthKeys}
        />
      )}
      {showPinAdmin && (
        <AdminPinSection
          integrationPackageId={packageId}
          agentPackageId={agentPackageId!}
          requiredAuthKeys={requiredAuthKeys}
          connections={connections ?? []}
        />
      )}
    </div>
  );
}

/**
 * R3 — pre-run picker for the member when a required (integration, authKey)
 * has more than one candidate connection (own + shared). Surfaces the
 * ambiguity BEFORE the user clicks Run, instead of letting the run-kickoff
 * 412 modal be the only place where the picker exists.
 *
 * The pick is persisted in `localStorage` (keyed by application + agent)
 * and read at mutate-time by `useRunAgent` so the resolver respects it
 * via `connectionOverrides`. An admin pin overrides any member pick.
 */
function MemberConnectionPicker({
  integrationPackageId,
  agentPackageId,
  requiredAuthKeys,
}: {
  integrationPackageId: string;
  agentPackageId: string;
  requiredAuthKeys: string[];
}) {
  const { t } = useTranslation(["agents"]);
  const applicationId = useCurrentApplicationId();
  const { data: pins } = useIntegrationPins(integrationPackageId);
  const { data: accessible } = useAccessibleIntegrationConnections(integrationPackageId);
  const { getPick, setPick } = useAgentConnectionPicks(applicationId, agentPackageId);

  // No accessible candidates → nothing to pick. The card already shows
  // "not connected" with a connect CTA in that case.
  const allCandidates = accessible ?? [];
  if (allCandidates.length === 0) return null;

  // Only render rows for required auths where:
  //   - there's no admin pin (admin pin wins over member pick)
  //   - >1 candidates exist (1 candidate is auto-resolved, no choice needed)
  const pickableRows = requiredAuthKeys
    .map((authKey) => {
      const pinned = pins?.find(
        (p) =>
          p.packageId === agentPackageId &&
          p.integrationPackageId === integrationPackageId &&
          p.authKey === authKey,
      );
      if (pinned) return null;
      const candidates = allCandidates.filter((c) => c.authKey === authKey);
      if (candidates.length < 2) return null;
      return { authKey, candidates };
    })
    .filter((r): r is { authKey: string; candidates: AccessibleIntegrationConnection[] } => !!r);

  if (pickableRows.length === 0) return null;

  return (
    <div
      className="border-border/60 bg-muted/30 ml-6 space-y-1.5 rounded-md border border-dashed px-3 py-2 text-xs"
      data-testid={`member-picker-${integrationPackageId}`}
    >
      <div className="text-muted-foreground flex items-center gap-1.5">
        <Users className="size-3" />
        <span>{t("detail.integrationMemberPicker.title")}</span>
      </div>
      <div className="space-y-1">
        {pickableRows.map(({ authKey, candidates }) => {
          const current = getPick(integrationPackageId, authKey) ?? "";
          return (
            <div key={authKey} className="flex items-center gap-2">
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
                {authKey}
              </span>
              <select
                className="border-border bg-background flex-1 rounded border px-2 py-1 text-xs"
                value={current}
                onChange={(e) => {
                  const value = e.target.value;
                  setPick(integrationPackageId, authKey, value === "" ? null : value);
                }}
                data-testid={`member-pick-${integrationPackageId}-${authKey}`}
              >
                <option value="">{t("detail.integrationMemberPicker.autoChoose")}</option>
                {candidates.map((c) => {
                  const ownership = c.ownerUserId
                    ? c.sharedWithOrg
                      ? t("detail.integrationMemberPicker.ownAndShared")
                      : t("detail.integrationMemberPicker.own")
                    : t("detail.integrationMemberPicker.shared");
                  const display = `${c.label ?? c.accountId} — ${ownership}`;
                  return (
                    <option key={c.id} value={c.id}>
                      {display}
                    </option>
                  );
                })}
              </select>
            </div>
          );
        })}
      </div>
      <p className="text-muted-foreground text-[0.65rem]">
        {t("detail.integrationMemberPicker.help")}
      </p>
    </div>
  );
}

/**
 * Admin-only "force this connection for this agent" row. Renders one
 * select per (integration, authKey) listing every shared connection the
 * admin can pin. Auto-saves on change. Hidden when:
 *   - the actor is not an admin
 *   - the integration has no shared (pinnable) connections
 *   - the agent declares no required auth on this integration
 *
 * Server-side `upsertIntegrationPin` enforces `sharedWithOrg=true` on
 * the pinned connection — the dropdown already filters to shared rows
 * so the UI surface matches the API contract without round-trip errors.
 */
function AdminPinSection({
  integrationPackageId,
  agentPackageId,
  requiredAuthKeys,
  connections,
}: {
  integrationPackageId: string;
  agentPackageId: string;
  requiredAuthKeys: string[];
  connections: IntegrationConnection[];
}) {
  const { t } = useTranslation(["agents"]);
  const { isAdmin } = usePermissions();
  const { data: pins } = useIntegrationPins(isAdmin ? integrationPackageId : undefined);
  const upsertPin = useUpsertIntegrationPin();
  const deletePin = useDeleteIntegrationPin();

  if (!isAdmin) return null;
  const pinnable = connections.filter((c) => c.sharedWithOrg);
  if (pinnable.length === 0) return null;

  return (
    <div
      className="border-border/60 bg-muted/30 ml-6 space-y-1.5 rounded-md border border-dashed px-3 py-2 text-xs"
      data-testid={`pin-section-${integrationPackageId}`}
    >
      <div className="text-muted-foreground flex items-center gap-1.5">
        <Pin className="size-3" />
        <span>{t("detail.integrationPin.title")}</span>
      </div>
      <div className="space-y-1">
        {requiredAuthKeys.map((authKey) => {
          const currentPin = pins?.find(
            (p) =>
              p.packageId === agentPackageId &&
              p.integrationPackageId === integrationPackageId &&
              p.authKey === authKey,
          );
          return (
            <div key={authKey} className="flex items-center gap-2">
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
                {authKey}
              </span>
              <select
                className="border-border bg-background flex-1 rounded border px-2 py-1 text-xs"
                value={currentPin?.connectionId ?? ""}
                disabled={upsertPin.isPending || deletePin.isPending}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === "") {
                    if (currentPin) {
                      deletePin.mutate({
                        packageId: integrationPackageId,
                        agentPackageId,
                        authKey,
                      });
                    }
                  } else {
                    upsertPin.mutate({
                      packageId: integrationPackageId,
                      agentPackageId,
                      authKey,
                      connectionId: value,
                    });
                  }
                }}
                data-testid={`pin-select-${integrationPackageId}-${authKey}`}
              >
                <option value="">{t("detail.integrationPin.none")}</option>
                {pinnable.map((c) => {
                  const accountLabel =
                    (c.identityClaims?.accountEmail as string | undefined) ??
                    (c.identityClaims?.account_email as string | undefined) ??
                    c.accountId;
                  const display = c.label ? `${c.label} (${accountLabel})` : accountLabel;
                  return (
                    <option key={c.id} value={c.id}>
                      {display}
                    </option>
                  );
                })}
              </select>
            </div>
          );
        })}
      </div>
      <p className="text-muted-foreground text-[0.65rem]">{t("detail.integrationPin.help")}</p>
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
): { authKey: string; scopes?: string[]; intent: "connect" | "fix" } | null {
  if (status.kind === "ok") return null;
  if (status.kind === "needs_reconnection") {
    return { authKey: status.authKey, intent: "fix" };
  }
  if (status.kind === "insufficient_scopes") {
    return { authKey: status.authKey, scopes: status.required, intent: "fix" };
  }
  // not_connected — pick first oauth2, falling back to first declared.
  const authKey = pickDefaultAuth(manifest.auths);
  return authKey ? { authKey, intent: "connect" } : null;
}

function CardShell({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
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
            <span className="truncate">{subtitle}</span>
          </div>
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
  | { kind: "needs_reconnection"; authKey: string }
  | { kind: "insufficient_scopes"; authKey: string; missing: string[]; required: string[] };

function deriveIntegrationStatus(input: {
  manifest: IntegrationManifestView;
  connections: { authKey: string; scopesGranted: string[]; needsReconnection: boolean }[];
  agentTools: string[] | undefined;
}): IntegrationStatus {
  const { manifest, connections, agentTools } = input;
  const auths = manifest.auths ?? {};
  const declaredAuthKeys = Object.keys(auths);
  if (declaredAuthKeys.length === 0) return { kind: "ok", authKey: "" };

  const requiredAuthKeys = requiredAuthKeysForAgent(manifest, agentTools);
  // No tools picked → integration is declared but inert; surface as
  // "ok" with empty authKey so the card doesn't render a "connect" CTA
  // for an unused integration. The picker is the place to opt in.
  if (requiredAuthKeys.length === 0) return { kind: "ok", authKey: "" };

  // Group by auth (multi-account → union scopes, OR needsReconnection)
  const byAuth = new Map<string, { scopesGranted: string[]; needsReconnection: boolean }>();
  for (const conn of connections) {
    const existing = byAuth.get(conn.authKey);
    if (!existing) {
      byAuth.set(conn.authKey, {
        scopesGranted: [...conn.scopesGranted],
        needsReconnection: conn.needsReconnection,
      });
    } else {
      for (const s of conn.scopesGranted) {
        if (!existing.scopesGranted.includes(s)) existing.scopesGranted.push(s);
      }
      existing.needsReconnection = existing.needsReconnection || conn.needsReconnection;
    }
  }

  const connected = requiredAuthKeys.filter((k) => byAuth.has(k));
  if (connected.length === 0) return { kind: "not_connected" };

  for (const authKey of connected) {
    const conn = byAuth.get(authKey)!;
    const auth = auths[authKey];
    if (!auth) continue;

    if (conn.needsReconnection) {
      return { kind: "needs_reconnection", authKey };
    }

    if (auth.type !== "oauth2") continue;

    const required = scopesContributedByTools({
      manifest,
      authKey,
      agentTools,
    });
    if (required.length === 0) continue;
    // Expand granted through the manifest's `availableScopes.implies`
    // hierarchy so a parent grant (e.g. GitHub `repo`) isn't flagged
    // as missing its narrower children (e.g. `public_repo`).
    const granted = new Set(expandGrantedScopes(conn.scopesGranted, manifest, authKey));
    const missing = required.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      return { kind: "insufficient_scopes", authKey, missing, required };
    }
  }

  // Single-auth-per-integration invariant (server-side gate in
  // saveIntegrationConnection) means `connected` has at most one entry
  // here in practice. Surface its authKey on the ok status so the card
  // can label "Connected via {auth}" + render a disconnect/switch CTA.
  return { kind: "ok", authKey: connected[0] ?? "" };
}

function renderStatus(
  status: IntegrationStatus,
  t: (k: string, opts?: Record<string, unknown>) => string,
): { icon: React.ReactNode; subtitle: string } {
  switch (status.kind) {
    case "ok":
      return {
        icon: <CheckCircle2 className="size-3 text-emerald-500" />,
        subtitle: status.authKey
          ? t("detail.integrationConnectedVia", { authKey: status.authKey })
          : t("detail.integrationConnected"),
      };
    case "not_connected":
      return {
        icon: <XCircle className="text-destructive size-3" />,
        subtitle: t("detail.integrationNotConnected"),
      };
    case "needs_reconnection":
      return {
        icon: <AlertTriangle className="size-3 text-amber-500" />,
        subtitle: t("detail.integrationNeedsReconnection", { authKey: status.authKey }),
      };
    case "insufficient_scopes":
      return {
        icon: <AlertTriangle className="size-3 text-amber-500" />,
        subtitle: t("detail.integrationMissingScopes", {
          scopes: status.missing.join(", "),
        }),
      };
  }
}
