// SPDX-License-Identifier: Apache-2.0

import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Unplug, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  useMyConnections,
  useDisconnectIntegrationConnection,
  useUpdateMeIntegrationConnection,
} from "../../hooks/use-me-connections";
import { formatDateField } from "../../lib/markdown";
import { LoadingState, EmptyState } from "../../components/page-states";
import { ConfirmModal } from "../../components/confirm-modal";
import type { MeConnectionEntry, MeConnectionSourceGroup } from "@appstrate/shared-types";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function statusBadge(t: ReturnType<typeof useTranslation>["t"], conn: MeConnectionEntry) {
  if (conn.needsReconnection) {
    return (
      <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-px text-[0.65rem] text-amber-600">
        {t("connectors.statusNeedsReconnection")}
      </span>
    );
  }
  return (
    <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-px text-[0.65rem] text-emerald-700">
      {t("connectors.statusConnected")}
    </span>
  );
}

// ─────────────────────────────────────────────
// Inline label edit (integration only)
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
        title={t("connectors.editLabel")}
      >
        <span>{current ?? t("connectors.unnamed")}</span>
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
        placeholder={t("connectors.labelPlaceholder")}
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
      label: t("connectors.account"),
      value: conn.identity,
    });
  }

  // Org + application
  rows.push({
    label: t("connectors.orgLabel"),
    value: (
      <>
        <span>{conn.org.name}</span>
        <span className="text-muted-foreground"> &middot; {conn.application.name}</span>
      </>
    ),
  });

  // Reuse hint (integration only) — tells the user this connection is
  // shared across N agents in the application, killing the "do I need
  // one connection per agent?" confusion.
  if (typeof conn.reusedByAgents === "number") {
    rows.push({
      label: t("connectors.reusedByLabel"),
      value:
        conn.reusedByAgents === 0
          ? t("connectors.reusedByNone")
          : t("connectors.reusedByCount", { count: conn.reusedByAgents }),
    });
  }

  // Connected at
  rows.push({
    label: t("connectors.connectedAtLabel"),
    value: conn.connectedAt ? formatDateField(conn.connectedAt) : "—",
  });

  // Scopes
  if (conn.scopesGranted.length > 0) {
    rows.push({
      label: t("connectors.scopesLabel"),
      value: conn.scopesGranted.join(", "),
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
              {conn.label ?? conn.identity ?? t("connectors.unnamed")}
            </span>
          )}
          {statusBadge(t, conn)}
          {conn.sharedWithOrg && (
            <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-px text-[0.65rem] text-blue-700">
              {t("connectors.sharedBadge")}
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

        {/* Share toggle (integration only) */}
        {onToggleShare && (
          <label className="text-muted-foreground inline-flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={conn.sharedWithOrg}
              disabled={updating}
              onChange={(e) => onToggleShare(e.target.checked)}
            />
            <span>{t("connectors.shareWithOrgLabel")}</span>
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
// Source group card (one per provider/integration)
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
              alt={group.displayName}
            />
          )}
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-[0.95rem] font-semibold">{group.displayName}</h3>
              <span className="text-muted-foreground border-border rounded-full border bg-transparent px-2 py-px text-[0.65rem] tracking-wide uppercase">
                {t("connectors.kindIntegration")}
              </span>
            </div>
            <span className="text-muted-foreground text-sm">
              {t("connectors.connectionCount", { count: group.totalConnections })}
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
            <div key={conn.connectionId}>{renderRow(conn)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────

export function PreferencesConnectorsPage() {
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
    reusedByAgents: number;
  } | null>(null);

  const totalConnections = useMemo(
    () => (groups ?? []).reduce((s, g) => s + g.totalConnections, 0),
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
          {t("connectors.myConnections")}
        </div>
        <span className="text-muted-foreground text-xs">
          {t("connectors.totalConnections", { count: totalConnections })}
        </span>
      </div>

      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <p className="text-muted-foreground text-sm">
          {t("connectors.descriptionUnified")}{" "}
          <Link to="/integrations" className="text-primary text-sm no-underline hover:underline">
            {t("connectors.connectMore")}
          </Link>
        </p>
      </div>

      {(groups ?? []).length === 0 ? (
        <EmptyState
          message={t("connectors.noConnections")}
          hint={t("connectors.noConnectionsHint")}
          icon={Unplug}
        >
          <Link to="/integrations">
            <Button variant="outline">{t("connectors.goToConnectors")}</Button>
          </Link>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {(groups ?? []).map((group) => {
            const key = `${group.kind}:${group.sourceId}`;
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
                        displayName: group.displayName,
                        identity: conn.identity,
                        connectionId: conn.connectionId,
                        reusedByAgents: conn.reusedByAgents ?? 0,
                      })
                    }
                    onUpdateLabel={(label) =>
                      updateIntegration.mutate({
                        packageId: group.sourceId,
                        connectionId: conn.connectionId,
                        orgId: conn.org.id,
                        applicationId: conn.application.id,
                        label,
                      })
                    }
                    onToggleShare={(next) =>
                      updateIntegration.mutate({
                        packageId: group.sourceId,
                        connectionId: conn.connectionId,
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
          const base = t("connectors.deleteConfirm", {
            name: confirmState.displayName,
            account: confirmState.identity ?? "",
          });
          // Impact list surfaces the blast radius so the user can
          // intentionally choose between deleting (here) vs changing the
          // agent-side pick (on the agent page).
          if (confirmState.reusedByAgents > 0) {
            return `${base}\n\n${t("connectors.deleteConfirmImpact", {
              count: confirmState.reusedByAgents,
            })}`;
          }
          return base;
        })()}
        isPending={disconnectIntegration.isPending}
        onConfirm={() => {
          if (!confirmState) return;
          disconnectIntegration.mutate(
            { connectionId: confirmState.connectionId },
            { onSuccess: () => setConfirmState(null) },
          );
        }}
      />
    </>
  );
}
