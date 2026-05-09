// SPDX-License-Identifier: Apache-2.0

import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDisconnect, useDeleteAllConnections } from "../../hooks/use-mutations";
import { useAllUserConnections } from "../../hooks/use-connection-profiles";
import { ProfileSelector } from "../../components/profile-selector";
import { formatDateField } from "../../lib/markdown";
import { LoadingState, EmptyState } from "../../components/page-states";
import { ConfirmModal } from "../../components/confirm-modal";
import { useProviders } from "../../hooks/use-providers";
import { resolveScopeLabel } from "../../lib/scope-labels";
import type { UserConnectionProviderGroup, UserConnectionEntry } from "@appstrate/shared-types";
import type { AvailableScope } from "@appstrate/core/validation";

function filterProviders(
  providers: UserConnectionProviderGroup[] | undefined,
  connectionProfileId: string | null,
): UserConnectionProviderGroup[] {
  if (!providers) return [];
  if (!connectionProfileId) return providers;
  return providers
    .map((pg) => {
      const orgs = pg.orgs
        .map((og) => ({
          ...og,
          connections: og.connections.filter((c) => c.profile.id === connectionProfileId),
        }))
        .filter((og) => og.connections.length > 0);
      const totalConnections = orgs.reduce((sum, og) => sum + og.connections.length, 0);
      return { ...pg, orgs, totalConnections };
    })
    .filter((pg) => pg.totalConnections > 0);
}

function ConnectionItem({
  conn,
  hasMultipleProfiles,
  onDisconnect,
  disconnecting,
  availableScopes,
}: {
  conn: UserConnectionEntry;
  hasMultipleProfiles: boolean;
  onDisconnect: () => void;
  disconnecting: boolean;
  availableScopes?: AvailableScope[];
}) {
  const { t } = useTranslation(["settings", "common"]);

  const rows: { label: string; value: React.ReactNode }[] = [];
  if (hasMultipleProfiles) {
    rows.push({
      label: t("connectors.profileLabel"),
      value: (
        <>
          {conn.profile.name}
          {conn.profile.isDefault && (
            <span className="border-border bg-background text-muted-foreground ml-1.5 inline-flex items-center rounded-full border px-2 py-px text-[0.65rem]">
              {t("profiles.default")}
            </span>
          )}
        </>
      ),
    });
  }
  rows.push(
    { label: t("connectors.applicationLabel"), value: conn.application.name },
    {
      label: t("connectors.connectedAtLabel"),
      value: conn.connectedAt ? formatDateField(conn.connectedAt) : "\u2014",
    },
  );
  if (conn.scopesGranted.length > 0) {
    rows.push({
      label: t("connectors.scopesLabel"),
      value: conn.scopesGranted.map((s) => resolveScopeLabel(s, availableScopes)).join(", "),
    });
  }

  return (
    <div className="border-border flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map((r) => (
          <Fragment key={r.label}>
            <span className="text-muted-foreground text-xs font-medium">{r.label}</span>
            <span className="text-foreground text-xs">{r.value}</span>
          </Fragment>
        ))}
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

function ProviderCard({
  provider: pg,
  expanded,
  onToggle,
  hasMultipleProfiles,
  onDisconnect,
  disconnecting,
  availableScopes,
}: {
  provider: UserConnectionProviderGroup;
  expanded: boolean;
  onToggle: () => void;
  hasMultipleProfiles: boolean;
  onDisconnect: (conn: UserConnectionEntry) => void;
  disconnecting: boolean;
  availableScopes?: AvailableScope[];
}) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <div className="border-border bg-card rounded-lg border p-5">
      <div className="flex cursor-pointer items-center justify-between" onClick={onToggle}>
        <div className="flex items-center gap-3">
          {pg.logo && (
            <img className="h-8 w-8 rounded-md object-contain" src={pg.logo} alt={pg.displayName} />
          )}
          <div className="flex-1">
            <h3 className="text-[0.95rem] font-semibold">{pg.displayName}</h3>
            <span className="text-muted-foreground text-sm">
              {t("connectors.connectionCount", { count: pg.totalConnections })}
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
        <div className="border-border mt-3 flex flex-col gap-3 border-t pt-3">
          {pg.orgs.map((og) => (
            <div key={og.orgId}>
              <div className="text-muted-foreground mb-2 text-xs font-medium">{og.orgName}</div>
              <div className="flex flex-col gap-2">
                {og.connections.map((conn) => (
                  <ConnectionItem
                    key={conn.connectionId}
                    conn={conn}
                    hasMultipleProfiles={hasMultipleProfiles}
                    availableScopes={availableScopes}
                    onDisconnect={() => onDisconnect(conn)}
                    disconnecting={disconnecting}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PreferencesConnectorsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: userConns, isLoading } = useAllUserConnections();
  const { data: providerConfigs } = useProviders();
  const disconnectMutation = useDisconnect();
  const deleteAllMutation = useDeleteAllConnections();

  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [filterProfileId, setFilterProfileId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<
    | { type: "deleteAll" }
    | {
        type: "disconnect";
        provider: string;
        profile: string;
        connectionId: string;
        providerId: string;
      }
    | null
  >(null);

  const providers = useMemo(
    () => filterProviders(userConns, filterProfileId),
    [userConns, filterProfileId],
  );

  const hasMultipleProfiles = useMemo(() => {
    const ids = new Set<string>();
    for (const pg of providers) {
      for (const og of pg.orgs) {
        for (const conn of og.connections) {
          ids.add(conn.profile.id);
        }
      }
    }
    return ids.size > 1;
  }, [providers]);

  if (isLoading) return <LoadingState />;

  const toggleExpand = (providerId: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  };

  const totalConnections = providers.reduce((sum, pg) => sum + pg.totalConnections, 0);

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-muted-foreground text-sm font-medium">
          {t("connectors.myConnections")}
        </div>
        <ProfileSelector showAllOption value={filterProfileId} onChange={setFilterProfileId} />
      </div>

      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">
            {t("connectors.description")}{" "}
            <Link to="/providers" className="text-primary text-sm no-underline hover:underline">
              {t("connectors.connectMore")}
            </Link>
          </p>
          {totalConnections > 0 && (
            <Button
              variant="destructive"
              onClick={() => setConfirmState({ type: "deleteAll" })}
              disabled={deleteAllMutation.isPending}
            >
              {deleteAllMutation.isPending
                ? t("connectors.deletingAll")
                : t("connectors.deleteAll")}
            </Button>
          )}
        </div>
      </div>

      {providers.length === 0 ? (
        <EmptyState
          message={t("connectors.noConnections")}
          hint={t("connectors.noConnectionsHint")}
          icon={Unplug}
        >
          <Link to="/providers">
            <Button variant="outline">{t("connectors.goToConnectors")}</Button>
          </Link>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {providers.map((pg) => (
            <ProviderCard
              key={pg.providerId}
              provider={pg}
              expanded={expandedProviders.has(pg.providerId)}
              onToggle={() => toggleExpand(pg.providerId)}
              hasMultipleProfiles={hasMultipleProfiles}
              onDisconnect={(conn) =>
                setConfirmState({
                  type: "disconnect",
                  provider: pg.displayName,
                  profile: conn.profile.name,
                  connectionId: conn.connectionId,
                  providerId: pg.providerId,
                })
              }
              disconnecting={disconnectMutation.isPending}
              availableScopes={
                providerConfigs?.find((p) => p.id === pg.providerId)?.availableScopes
              }
            />
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={
          confirmState?.type === "deleteAll"
            ? t("connectors.deleteAllConfirm")
            : confirmState?.type === "disconnect"
              ? t("connectors.deleteConfirm", {
                  provider: confirmState.provider,
                  profile: confirmState.profile,
                })
              : ""
        }
        isPending={
          confirmState?.type === "deleteAll"
            ? deleteAllMutation.isPending
            : disconnectMutation.isPending
        }
        onConfirm={() => {
          if (confirmState?.type === "deleteAll") {
            deleteAllMutation.mutate(undefined, {
              onSuccess: () => setConfirmState(null),
            });
          } else if (confirmState?.type === "disconnect") {
            disconnectMutation.mutate(
              { provider: confirmState.providerId, connectionId: confirmState.connectionId },
              { onSuccess: () => setConfirmState(null) },
            );
          }
        }}
      />
    </>
  );
}
