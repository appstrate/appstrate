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
  useConnectionDeleteImpact,
  useDisconnectIntegrationConnection,
  useRenameMeConnection,
} from "../../hooks/use-me-connections";
import { useConnectionShare } from "../../hooks/use-integrations";
import { formatDateField } from "../../lib/format-date";
import { LoadingState, EmptyState } from "../../components/page-states";
import { ConfirmModal } from "../../components/confirm-modal";
import { ConnectionStatusBadge } from "../../components/integration-connect/connection-status-badge";
import { ConnectionTeardownSteps } from "../../components/integration-connect/connection-teardown-steps";
import { ConnectionDeleteImpact } from "../../components/integration-connect/connection-delete-impact";
import { isQueryInFlight } from "../../lib/query-state";
import type { MeConnectionEntry, MeConnectionSourceGroup } from "@appstrate/shared-types";
import { useCanReach } from "../../hooks/use-can-reach";
import { DisabledReasonTooltip } from "../../components/disabled-reason-tooltip";
import { connectionLockHintKey } from "../../components/integration-connect/connection-ownership";
import { ConnectionScopeBadge } from "../../components/integration-connect/connection-scope-badge";
import { ConnectionShareEditor } from "../../components/integration-connect/connection-share-editor";

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
  current: string;
  saving: boolean;
  /** Calls `onSuccess` once saved: a refused label (e.g. already taken) stays open to fix. */
  onSave: (next: string, onSuccess: () => void) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(current);
          setEditing(true);
        }}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs"
        title={t("connections.editLabel")}
      >
        <span>{current}</span>
        <Pencil className="h-3 w-3" />
      </button>
    );
  }

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === current) setEditing(false);
    else onSave(trimmed, () => setEditing(false));
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
  onRename,
  onShare,
  onUnshare,
  disconnecting,
  renaming,
  sharing,
}: {
  conn: MeConnectionEntry;
  onDisconnect: () => void;
  onRename: (label: string, onSuccess: () => void) => void;
  onShare: (spaceId: string) => void;
  onUnshare: (spaceId: string) => void;
  disconnecting: boolean;
  renaming: boolean;
  sharing: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  // A pin or default names it: delete answers 409 until removed there.
  const lockKey = connectionLockHintKey(conn.locked_by);
  const lockHint = lockKey ? t(lockKey) : null;
  const canRename = conn.allowed_actions.includes("rename");
  const canShare = conn.allowed_actions.includes("share");
  // Shareable spaces and the ones it is already shared into, one entry each.
  const shareTargets = [
    ...conn.shareable_spaces,
    ...conn.shared_spaces.filter((s) => !conn.shareable_spaces.some((c) => c.id === s.id)),
  ];

  const rows: { label: string; value: React.ReactNode }[] = [];

  // Identity (account email / profile name)
  if (conn.identity) {
    rows.push({
      label: t("connections.account"),
      value: conn.identity,
    });
  }

  // Org, and the one space a space-scoped row lives in
  rows.push({
    label: t("connections.orgLabel"),
    value: (
      <>
        <span>{conn.org.name}</span>
        {conn.space && <span className="text-muted-foreground"> &middot; {conn.space.name}</span>}
      </>
    ),
  });

  if (conn.origin_space) {
    rows.push({ label: t("connections.originLabel"), value: conn.origin_space.name });
  }

  rows.push({
    label: t("connections.sharedSpacesLabel"),
    value:
      conn.shared_spaces.length > 0
        ? conn.shared_spaces.map((s) => s.name).join(", ")
        : t("connections.sharedSpacesNone"),
  });

  // Reuse hint — the agents of its spaces that use it, killing the "do I need one
  // connection per agent?" confusion.
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
          {canRename ? (
            <LabelEditor current={conn.label} saving={renaming} onSave={onRename} />
          ) : (
            <span className="text-foreground text-sm font-medium">{conn.label}</span>
          )}
          {statusBadge(t, conn)}
          <ConnectionScopeBadge scope={conn.scope} />
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

        <div className="flex flex-wrap items-center gap-2">
          <ConnectionShareEditor
            connectionId={conn.connection_id}
            scope={conn.scope}
            rowSpaceId={conn.space?.id ?? null}
            hereSpaceId={null}
            targets={shareTargets}
            sharedSpaceIds={conn.shared_spaces.map((s) => s.id)}
            sharedHere={false}
            canShare={canShare}
            canUnshareHere={false}
            lockHint={null}
            pending={sharing}
            onShare={onShare}
            onUnshare={onUnshare}
          />
          {lockHint && <span className="text-muted-foreground text-[0.65rem]">{lockHint}</span>}
        </div>
      </div>

      <DisabledReasonTooltip reason={lockHint}>
        <Button
          variant="destructive"
          size="sm"
          className="shrink-0"
          onClick={onDisconnect}
          disabled={disconnecting || !!lockHint}
        >
          {t("btn.disconnect")}
        </Button>
      </DisabledReasonTooltip>
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
  const canBrowseIntegrations = useCanReach()("/integrations");

  const disconnectIntegration = useDisconnectIntegrationConnection();
  const renameIntegration = useRenameMeConnection();
  const shareIntegration = useConnectionShare("share");
  const unshareIntegration = useConnectionShare("unshare");

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmState, setConfirmState] = useState<{
    kind: "integration";
    displayName: string;
    identity: string | null;
    connectionId: string;
  } | null>(null);
  const deleteImpact = useConnectionDeleteImpact(confirmState?.connectionId);

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
          {t("connections.descriptionUnified")}
          {canBrowseIntegrations && (
            <>
              {" "}
              <Link
                to="/integrations"
                className="text-primary text-sm no-underline hover:underline"
              >
                {t("connections.connectMore")}
              </Link>
            </>
          )}
        </p>
      </div>

      {(groups ?? []).length === 0 ? (
        <EmptyState
          message={t("connections.noConnections")}
          hint={t("connections.noConnectionsHint")}
          icon={Unplug}
        >
          {canBrowseIntegrations && (
            <Link to="/integrations">
              <Button variant="outline">{t("connections.goToConnections")}</Button>
            </Link>
          )}
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
                    renaming={renameIntegration.isPending}
                    sharing={shareIntegration.isPending || unshareIntegration.isPending}
                    onDisconnect={() =>
                      setConfirmState({
                        kind: "integration",
                        displayName: group.display_name,
                        identity: conn.identity,
                        connectionId: conn.connection_id,
                      })
                    }
                    onRename={(label, onSuccess) =>
                      renameIntegration.mutate(
                        { connectionId: conn.connection_id, body: { label } },
                        { onSuccess },
                      )
                    }
                    onShare={(spaceId) =>
                      shareIntegration.mutate({ connectionId: conn.connection_id, spaceId })
                    }
                    onUnshare={(spaceId) =>
                      unshareIntegration.mutate({ connectionId: conn.connection_id, spaceId })
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
        // The blast radius is `ConnectionDeleteImpact` below — the caller's own
        // pins and schedules the delete rewrites, and the count of other people's
        // schedules it disables — not a second sentence here.
        description={
          confirmState
            ? t("connections.deleteConfirm", {
                name: confirmState.displayName,
                account: confirmState.identity ?? "",
              })
            : ""
        }
        isPending={disconnectIntegration.isPending}
        confirmDisabled={isQueryInFlight(deleteImpact)}
        onConfirm={() => {
          if (!confirmState) return;
          disconnectIntegration.mutate(
            { params: { path: { connectionId: confirmState.connectionId } } },
            { onSuccess: () => setConfirmState(null) },
          );
        }}
      >
        {confirmState && (
          <>
            <ConnectionDeleteImpact impact={deleteImpact} />
            <ConnectionTeardownSteps connectionId={confirmState.connectionId} />
          </>
        )}
      </ConfirmModal>
    </>
  );
}
