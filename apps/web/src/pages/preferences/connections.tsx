// SPDX-License-Identifier: Apache-2.0

import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Unplug, Pencil, Check, X } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { cn } from "@appstrate/ui/cn";
import {
  useMyConnections,
  useDisconnectIntegrationConnection,
  useUpdateMeIntegrationConnection,
} from "../../hooks/use-me-connections";
import { formatDateField } from "../../lib/markdown";
import { LoadingState, EmptyState } from "../../components/page-states";
import { ConfirmModal } from "../../components/confirm-modal";
import { ConnectionStatusBadge } from "../../components/integration-connect/connection-status-badge";
import type { MeConnectionEntry, MeConnectionSourceGroup } from "@appstrate/shared-types";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function statusBadge(t: ReturnType<typeof useTranslation>["t"], conn: MeConnectionEntry) {
  return conn.needs_reconnection ? (
    <ConnectionStatusBadge tone="needsReconnection">
      {t("connections.statusNeedsReconnection")}
    </ConnectionStatusBadge>
  ) : (
    <ConnectionStatusBadge tone="connected">
      {t("connections.statusConnected")}
    </ConnectionStatusBadge>
  );
}

// ─────────────────────────────────────────────
// Inline label edit
// ─────────────────────────────────────────────

function LabelEditor({
  current,
  saving,
  onSave,
}: {
  current: string | null;
  saving: boolean;
  onSave: (next: string | null) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current ?? "");

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(current ?? "");
          setEditing(true);
        }}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs"
        title={t("connections.editLabel")}
      >
        <span>{current ?? t("connections.unnamed")}</span>
        <Pencil className="h-3 w-3" />
      </button>
    );
  }

  const commit = () => {
    const trimmed = value.trim();
    onSave(trimmed.length === 0 ? null : trimmed);
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-7 w-40 text-xs"
        disabled={saving}
        placeholder={t("connections.labelPlaceholder")}
      />
      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={commit} disabled={saving}>
        <Check className="h-3 w-3" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6"
        onClick={() => setEditing(false)}
        disabled={saving}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────
// Connection row (integration connection)
// ─────────────────────────────────────────────

function ConnectionRow({
  conn,
  onDisconnect,
  onUpdateLabel,
  onToggleShare,
  disconnecting,
  updating,
}: {
  conn: MeConnectionEntry;
  onDisconnect: () => void;
  onUpdateLabel?: (label: string | null) => void;
  onToggleShare?: (next: boolean) => void;
  disconnecting: boolean;
  updating: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);

  const rows: { label: string; value: React.ReactNode }[] = [];

  // Identity (account email / profile name)
  if (conn.identity) {
    rows.push({
      label: t("connections.account"),
      value: conn.identity,
    });
  }

  // Org + application
  rows.push({
    label: t("connections.orgLabel"),
    value: (
      <>
        <span>{conn.org.name}</span>
        <span className="text-muted-foreground"> &middot; {conn.application.name}</span>
      </>
    ),
  });

  // Reuse hint — tells the user this connection is
  // shared across N agents in the application, killing the "do I need
  // one connection per agent?" confusion.
  if (typeof conn.reused_by_agents === "number") {
    rows.push({
      label: t("connections.reusedByLabel"),
      value:
        conn.reused_by_agents === 0
          ? t("connections.reusedByNone")
          : t("connections.reusedByCount", { count: conn.reused_by_agents }),
    });
  }

  // Connected at
  rows.push({
    label: t("connections.connectedAtLabel"),
    value: conn.connected_at ? formatDateField(conn.connected_at) : "—",
  });

  // Scopes
  if (conn.scopes_granted.length > 0) {
    rows.push({
      label: t("connections.scopesLabel"),
      value: conn.scopes_granted.join(", "),
    });
  }

  return (
    <div className="border-border flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="flex flex-1 flex-col gap-2">
        {/* Header: label (editable for integration) + status */}
        <div className="flex flex-wrap items-center gap-2">
          {onUpdateLabel ? (
            <LabelEditor current={conn.label} saving={updating} onSave={onUpdateLabel} />
          ) : (
            <span className="text-foreground text-sm font-medium">
              {conn.label ?? conn.identity ?? t("connections.unnamed")}
            </span>
          )}
          {statusBadge(t, conn)}
          {conn.shared_with_org && (
            <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-px text-[0.65rem] text-blue-700">
              {t("connections.sharedBadge")}
            </span>
          )}
        </div>

        {/* Detail rows */}
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {rows.map((r, i) => (
            <Fragment key={`${r.label}-${i}`}>
              <span className="text-muted-foreground text-xs font-medium">{r.label}</span>
              <span className="text-foreground text-xs">{r.value}</span>
            </Fragment>
          ))}
        </div>

        {/* Share toggle */}
        {onToggleShare && (
          <label className="text-muted-foreground inline-flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={conn.shared_with_org}
              disabled={updating}
              onChange={(e) => onToggleShare(e.target.checked)}
            />
            <span>{t("connections.shareWithOrgLabel")}</span>
          </label>
        )}
      </div>

      <Button
        variant="destructive"
        size="sm"
        className="shrink-0"
        onClick={onDisconnect}
        disabled={disconnecting}
      >
        {t("btn.disconnect")}
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────
// Source group card (one per integration)
// ─────────────────────────────────────────────

function SourceGroupCard({
  group,
  expanded,
  onToggle,
  renderRow,
}: {
  group: MeConnectionSourceGroup;
  expanded: boolean;
  onToggle: () => void;
  renderRow: (conn: MeConnectionEntry) => React.ReactNode;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <div className="border-border bg-card rounded-lg border p-5">
      <div className="flex cursor-pointer items-center justify-between" onClick={onToggle}>
        <div className="flex items-center gap-3">
          {group.logo && (
            <img
              className="h-8 w-8 rounded-md object-contain"
              src={group.logo}
              alt={group.display_name}
            />
          )}
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-[0.95rem] font-semibold">{group.display_name}</h3>
              <span className="text-muted-foreground border-border rounded-full border bg-transparent px-2 py-px text-[0.65rem] tracking-wide uppercase">
                {t("connections.kindIntegration")}
              </span>
            </div>
            <span className="text-muted-foreground text-sm">
              {t("connections.connectionCount", { count: group.total_connections })}
            </span>
          </div>
        </div>
        <span
          className={cn(
            "text-muted-foreground text-xs transition-transform duration-200",
            expanded && "rotate-90",
          )}
        >
          &#9654;
        </span>
      </div>

      {expanded && (
        <div className="border-border mt-3 flex flex-col gap-2 border-t pt-3">
          {group.connections.map((conn) => (
            <div key={conn.connection_id}>{renderRow(conn)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────

export function PreferencesConnectionsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: groups, isLoading } = useMyConnections();

  const disconnectIntegration = useDisconnectIntegrationConnection();
  const updateIntegration = useUpdateMeIntegrationConnection();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmState, setConfirmState] = useState<{
    kind: "integration";
    displayName: string;
    identity: string | null;
    connectionId: string;
    /**
     * Number of agents that consume this integration in the application —
     * surfaced in the confirm dialog so the user understands the blast
     * radius before deleting the connection globally.
     */
    reused_by_agents: number;
  } | null>(null);

  const totalConnections = useMemo(
    () => (groups ?? []).reduce((s, g) => s + g.total_connections, 0),
    [groups],
  );

  if (isLoading) return <LoadingState />;

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-muted-foreground text-sm font-medium">
          {t("connections.myConnections")}
        </div>
        <span className="text-muted-foreground text-xs">
          {t("connections.totalConnections", { count: totalConnections })}
        </span>
      </div>

      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <p className="text-muted-foreground text-sm">
          {t("connections.descriptionUnified")}{" "}
          <Link to="/integrations" className="text-primary text-sm no-underline hover:underline">
            {t("connections.connectMore")}
          </Link>
        </p>
      </div>

      {(groups ?? []).length === 0 ? (
        <EmptyState
          message={t("connections.noConnections")}
          hint={t("connections.noConnectionsHint")}
          icon={Unplug}
        >
          <Link to="/integrations">
            <Button variant="outline">{t("connections.goToConnections")}</Button>
          </Link>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {(groups ?? []).map((group) => {
            const key = `${group.kind}:${group.source_id}`;
            return (
              <SourceGroupCard
                key={key}
                group={group}
                expanded={expanded.has(key)}
                onToggle={() => toggle(key)}
                renderRow={(conn) => (
                  <ConnectionRow
                    conn={conn}
                    disconnecting={disconnectIntegration.isPending}
                    updating={updateIntegration.isPending}
                    onDisconnect={() =>
                      setConfirmState({
                        kind: "integration",
                        displayName: group.display_name,
                        identity: conn.identity,
                        connectionId: conn.connection_id,
                        reused_by_agents: conn.reused_by_agents ?? 0,
                      })
                    }
                    onUpdateLabel={(label) =>
                      updateIntegration.mutate({
                        packageId: group.source_id,
                        connectionId: conn.connection_id,
                        orgId: conn.org.id,
                        applicationId: conn.application.id,
                        label,
                      })
                    }
                    onToggleShare={(next) =>
                      updateIntegration.mutate({
                        packageId: group.source_id,
                        connectionId: conn.connection_id,
                        orgId: conn.org.id,
                        applicationId: conn.application.id,
                        sharedWithOrg: next,
                      })
                    }
                  />
                )}
              />
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={(() => {
          if (!confirmState) return "";
          const base = t("connections.deleteConfirm", {
            name: confirmState.displayName,
            account: confirmState.identity ?? "",
          });
          // Impact list surfaces the blast radius so the user can
          // intentionally choose between deleting (here) vs changing the
          // agent-side pick (on the agent page).
          if (confirmState.reused_by_agents > 0) {
            return `${base}\n\n${t("connections.deleteConfirmImpact", {
              count: confirmState.reused_by_agents,
            })}`;
          }
          return base;
        })()}
        isPending={disconnectIntegration.isPending}
        onConfirm={() => {
          if (!confirmState) return;
          disconnectIntegration.mutate(
            { params: { path: { connectionId: confirmState.connectionId } } },
            { onSuccess: () => setConfirmState(null) },
          );
        }}
      />
    </>
  );
}
