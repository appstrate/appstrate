// SPDX-License-Identifier: Apache-2.0

import { Card } from "@appstrate/ui/components/card";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Unplug, Pencil, Trash2 } from "lucide-react";
import { DropdownMenuLabel } from "@appstrate/ui/components/dropdown-menu";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { useMyConnections, useRenameMeConnection } from "../../hooks/use-me-connections";
import { useConnectionShareAllSpaces, useConnectionShare } from "../../hooks/use-integrations";
import { formatDateField } from "../../lib/format-date";
import { EmptyState } from "../../components/page-states";
import { ItemList } from "../../components/item-list";
import { PackageIcon } from "../../components/package-icon";
import { InlineEditableLabel } from "../../components/inline-editable-label";
import { TableRowActions } from "../../components/table-row-actions";
import { ConnectionStatusBadge } from "../../components/integration-connect/connection-status-badge";
import { ConnectionDeleteConfirm } from "../../components/integration-connect/connection-delete-confirm";
import type { MeConnectionEntry, MeConnectionSourceGroup } from "@appstrate/shared-types";
import { useCanReach } from "../../hooks/use-can-reach";
import { connectionLockHintKey } from "../../components/integration-connect/connection-ownership";
import { usePermissions } from "../../hooks/use-permissions";
import { ConnectionScopeBadge } from "../../components/integration-connect/connection-scope-badge";
import { ConnectionShareEditor } from "../../components/integration-connect/connection-share-editor";

// ─────────────────────────────────────────────
// Connection row (integration connection)
// ─────────────────────────────────────────────

function ConnectionRow({
  conn,
  onRename,
  onShare,
  onShareAllSpacesChange,
  onUnshare,
  sharing,
}: {
  conn: MeConnectionEntry;
  onRename: (label: string) => Promise<unknown>;
  onShare: (spaceId: string) => void;
  onShareAllSpacesChange: (enabled: boolean) => void;
  onUnshare: (spaceId: string) => void;
  sharing: boolean;
}) {
  const { t } = useTranslation(["settings", "common", "agents"]);
  const { can } = usePermissions();
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A pin or default names it: delete answers 409 until removed there.
  const lockKey = connectionLockHintKey(conn.locked_by, can("integrations:configure"));
  const lockHint = lockKey ? t(lockKey) : null;
  const canRename = conn.allowed_actions.includes("rename");
  const canShare = conn.allowed_actions.includes("share");
  const canShareAllSpaces = conn.allowed_actions.includes("share_all_spaces");
  // Shareable spaces and the ones it is already shared into, one entry each.
  const shareTargets = [
    ...conn.shareable_spaces,
    ...conn.shared_spaces.filter((s) => !conn.shareable_spaces.some((c) => c.id === s.id)),
  ];

  const rows: { label: string; value: React.ReactNode }[] = [];

  // Identity (account email / profile name)
  if (conn.identity) {
    rows.push({
      label: t("preferences.sectionAccount"),
      value: conn.identity,
    });
  }

  // Org, and the one space a space-scoped row lives in
  rows.push({
    label: t("source.org"),
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
        : t("viewAs.noSpace"),
  });

  // Reuse hint — the agents of its spaces that declare the integration, killing the
  // "do I need one connection per agent?" confusion.
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
    value: formatDateField(conn.connected_at),
  });

  // Scopes
  if (conn.scopes_granted.length > 0) {
    rows.push({
      label: t("roles.permissionsLabel"),
      value: conn.scopes_granted.join(", "),
    });
  }

  return (
    <div
      data-row
      className="border-border flex items-start justify-between gap-4 rounded-md border p-3"
    >
      <div className="flex flex-1 flex-col gap-2">
        {/* Header: label (editable for integration) + status */}
        <div className="flex flex-wrap items-center gap-2">
          <InlineEditableLabel
            value={conn.label}
            editable={canRename}
            editing={renaming}
            onEditingChange={setRenaming}
            placeholder={t("connections.labelPlaceholder")}
            onSave={async (label) => {
              await onRename(label);
            }}
          />
          <ConnectionStatusBadge needsReconnection={conn.needs_reconnection} />
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
            canShareAllSpaces={canShareAllSpaces}
            shareAllSpaces={conn.share_all_spaces ?? false}
            onShareAllSpacesChange={onShareAllSpacesChange}
            onUnshare={onUnshare}
          />
          {lockHint && <span className="text-muted-foreground text-[0.65rem]">{lockHint}</span>}
        </div>
      </div>

      <TableRowActions
        menuLabel={t("providers.moreActions", { name: conn.label })}
        renaming={renaming}
        actions={[
          {
            id: "rename",
            label: t("btn.rename", { ns: "common" }),
            icon: Pencil,
            onSelect: () => setRenaming(true),
            hidden: !canRename,
          },
          {
            id: "delete",
            label: t("integration.connection.delete"),
            icon: Trash2,
            onSelect: () => setConfirmDelete(true),
            disabled: !!lockHint,
            destructive: true,
          },
        ]}
      >
        {/* Said in the menu, where the dead item is: a disabled item takes no hover. */}
        {lockHint && (
          <DropdownMenuLabel className="text-muted-foreground max-w-64 text-xs font-normal">
            {lockHint}
          </DropdownMenuLabel>
        )}
      </TableRowActions>
      <ConnectionDeleteConfirm
        connectionId={conn.connection_id}
        name={conn.label}
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
      />
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
    <Card className="p-5">
      <div className="flex cursor-pointer items-center justify-between" onClick={onToggle}>
        <div className="flex items-center gap-3">
          <PackageIcon type="integration" id={group.source_id} icon={group.logo} size="sm" />
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
            "text-muted-foreground duration-fast ease-surface text-xs transition-transform",
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
    </Card>
  );
}

// ─────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────

export function PreferencesConnectionsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: groups, isLoading, error } = useMyConnections();
  const canBrowseIntegrations = useCanReach()("/integrations");

  const renameIntegration = useRenameMeConnection();
  const shareIntegration = useConnectionShare("share");
  const allSpacesSharing = useConnectionShareAllSpaces();
  const unshareIntegration = useConnectionShare("unshare");

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const totalConnections = useMemo(
    () => (groups ?? []).reduce((s, g) => s + g.total_connections, 0),
    [groups],
  );

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
        {isLoading ? (
          <Skeleton className="h-3 w-20" />
        ) : (
          <span className="text-muted-foreground text-xs">
            {t("connections.totalConnections", { count: totalConnections })}
          </span>
        )}
      </div>

      <Card className="mb-4 p-5">
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
      </Card>

      <ItemList
        items={groups ?? []}
        itemKey={(group) => `${group.kind}:${group.source_id}`}
        isLoading={isLoading}
        failure={error}
        empty={
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
        }
        renderItem={(group) => {
          const key = `${group.kind}:${group.source_id}`;
          return (
            <SourceGroupCard
              group={group}
              expanded={expanded.has(key)}
              onToggle={() => toggle(key)}
              renderRow={(conn) => (
                <ConnectionRow
                  conn={conn}
                  sharing={
                    shareIntegration.isPending ||
                    unshareIntegration.isPending ||
                    allSpacesSharing.isPending
                  }
                  onRename={(label) =>
                    renameIntegration.mutateAsync({
                      connectionId: conn.connection_id,
                      body: { label },
                    })
                  }
                  onShare={(spaceId) =>
                    shareIntegration.mutate({ connectionId: conn.connection_id, spaceId })
                  }
                  onShareAllSpacesChange={(enabled) =>
                    allSpacesSharing.mutate({ connectionId: conn.connection_id, enabled })
                  }
                  onUnshare={(spaceId) =>
                    unshareIntegration.mutate({ connectionId: conn.connection_id, spaceId })
                  }
                />
              )}
            />
          );
        }}
      />
    </>
  );
}
