// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, AlertTriangle, XCircle, Loader2, Puzzle, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
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

  const status = deriveIntegrationStatus({
    manifest: detail.manifest,
    connections: connections ?? [],
    agentTools,
  });

  const { icon, subtitle } = renderStatus(status, t);
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
  // this block now carries only member-facing widgets.
  const requiredAuthKeys = requiredAuthKeysForAgent(detail.manifest, agentTools);
  const showMemberPicker = !!agentPackageId && requiredAuthKeys.length > 0;

  return (
    <div className="space-y-2">
      <CardShell icon={icon} title={displayName} subtitle={subtitle} extraSubtitle={reuseInfo}>
        {action && (
          <InlineConnectButton
            packageId={packageId}
            authKey={action.authKey}
            scopes={action.scopes}
            intent={action.intent}
          />
        )}
      </CardShell>
      {showMemberPicker && (
        <MemberConnectionPicker
          integrationPackageId={packageId}
          agentPackageId={agentPackageId!}
          requiredAuthKeys={requiredAuthKeys}
        />
      )}
    </div>
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
 * R3 + R5 — pre-run picker for the member when a required (integration,
 * authKey) has more than one candidate connection. Surfaces ambiguity
 * BEFORE the user clicks Run.
 *
 * R5 polish: collapse by default. When the actor has their own connection
 * among the candidates, that's silently the implicit default (resolver
 * already prefers own at fallback time) — we render only a small "Use
 * another connection" link. Clicking expands the full select.
 *
 * Picks are persisted as `integration_pins` rows with `user_id` set —
 * the resolver sees them at cascade layer 4 on every run. Admin pins
 * (`user_id IS NULL`) at layer 1 lock the choice for everyone: when an
 * admin pin exists on a (integration, authKey), the picker renders a
 * read-only "locked by admin" row and refuses writes.
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
  const { data: adminPins } = useIntegrationPins(integrationPackageId);
  const { data: memberPins } = useMemberIntegrationPins(agentPackageId);
  const { data: accessible } = useAccessibleIntegrationConnections(integrationPackageId);
  const upsertPin = useUpsertMemberIntegrationPin();
  const deletePin = useDeleteMemberIntegrationPin();

  const allCandidates = accessible ?? [];
  if (allCandidates.length === 0) return null;

  type PickerRowSpec =
    | { kind: "locked"; authKey: string; label: string }
    | {
        kind: "pickable";
        authKey: string;
        candidates: AccessibleIntegrationConnection[];
        current: string | null;
      };

  const rows: PickerRowSpec[] = requiredAuthKeys.flatMap((authKey): PickerRowSpec[] => {
    const adminPin = adminPins?.find(
      (p) =>
        p.packageId === agentPackageId &&
        p.integrationPackageId === integrationPackageId &&
        p.authKey === authKey,
    );
    if (adminPin) {
      // Cas 3 — admin force pin: locked, member cannot pick anything.
      const pinned = allCandidates.find((c) => c.id === adminPin.connectionId);
      return [{ kind: "locked", authKey, label: pinned?.label ?? pinned?.accountId ?? "" }];
    }
    const candidates = allCandidates.filter((c) => c.authKey === authKey);
    if (candidates.length < 2) return [];
    const memberPin = memberPins?.find(
      (p) => p.integrationPackageId === integrationPackageId && p.authKey === authKey,
    );
    return [
      {
        kind: "pickable",
        authKey,
        candidates,
        current: memberPin?.connectionId ?? null,
      },
    ];
  });

  if (rows.length === 0) return null;

  return (
    <div className="ml-6 space-y-1" data-testid={`member-picker-${integrationPackageId}`}>
      {rows.map((row) =>
        row.kind === "locked" ? (
          <LockedByAdminRow key={row.authKey} authKey={row.authKey} label={row.label} t={t} />
        ) : (
          <PickerRow
            key={row.authKey}
            integrationPackageId={integrationPackageId}
            authKey={row.authKey}
            candidates={row.candidates}
            current={row.current}
            onChange={(connectionId) => {
              if (connectionId === null) {
                deletePin.mutate({
                  agentPackageId,
                  integrationPackageId,
                  authKey: row.authKey,
                });
              } else {
                upsertPin.mutate({
                  agentPackageId,
                  integrationPackageId,
                  authKey: row.authKey,
                  connectionId,
                });
              }
            }}
            t={t}
          />
        ),
      )}
    </div>
  );
}

/**
 * Cas 3 — admin pin lock. The connection used for this (integration,
 * authKey) is forced for every actor; no member pick is possible.
 */
function LockedByAdminRow({
  authKey,
  label,
  t,
}: {
  authKey: string;
  label: string;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[0.7rem]">
      <Users className="size-3" />
      <span>{t("detail.integrationMemberPicker.lockedByAdmin", { authKey, label })}</span>
    </div>
  );
}

/**
 * Collapsed-by-default picker row. Resolves the candidate that would be
 * auto-selected (the actor's own connection if any, else the first shared),
 * displays it as a label, and gates the full select behind a click.
 */
function PickerRow({
  integrationPackageId,
  authKey,
  candidates,
  current,
  onChange,
  t,
}: {
  integrationPackageId: string;
  authKey: string;
  candidates: AccessibleIntegrationConnection[];
  current: string | null;
  onChange: (next: string | null) => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const own = candidates.find((c) => c.ownerUserId);
  const implicit = own ?? candidates[0]!;
  const explicit = current ? (candidates.find((c) => c.id === current) ?? implicit) : implicit;
  const isImplicit = !current;

  if (!expanded) {
    return (
      <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[0.7rem]">
        <Users className="size-3" />
        <span>
          {t("detail.integrationMemberPicker.usingLine", {
            label: explicit.label ?? explicit.accountId,
          })}
        </span>
        {isImplicit && (
          <span className="text-muted-foreground/70">
            {t("detail.integrationMemberPicker.defaultBadge")}
          </span>
        )}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-primary hover:underline"
          data-testid={`member-pick-expand-${integrationPackageId}-${authKey}`}
        >
          {t("detail.integrationMemberPicker.changeLink")}
        </button>
      </div>
    );
  }

  return (
    <div className="border-border/60 bg-muted/30 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
      <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
        {authKey}
      </span>
      <select
        className="border-border bg-background flex-1 rounded border px-2 py-1 text-xs"
        value={current ?? ""}
        onChange={(e) => {
          const value = e.target.value;
          onChange(value === "" ? null : value);
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
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6"
        onClick={() => setExpanded(false)}
        title={t("detail.integrationMemberPicker.close")}
      >
        <X className="h-3 w-3" />
      </Button>
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
  if (status.kind === "insufficient_scopes") {
    // Upgrade-in-place: backend unions defaults + required + already-granted,
    // so the IdP shows an incremental-consent screen for the missing scopes
    // only and the existing connection row is preserved (upserted).
    return { authKey: status.authKey, scopes: status.required, intent: "upgrade" };
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
  icon: React.ReactNode;
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
            <span className="truncate">{subtitle}</span>
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
