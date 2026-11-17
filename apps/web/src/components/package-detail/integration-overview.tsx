// SPDX-License-Identifier: Apache-2.0

import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Layers, Plug, Wrench } from "lucide-react";
import { HealthCard, HealthCardItem, HealthAction, HealthIssueBadge } from "../health-card";
import type { IntegrationDetailWire, IntegrationAuthStatus } from "../../hooks/use-integrations";
import { useAgents } from "../../hooks/use-packages";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { useCurrentSpaceId, useSpaceLink } from "../../hooks/use-current-space";
import { useMyConnections } from "../../hooks/use-me-connections";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useSpaceLabelOf } from "../../hooks/use-spaces";
import { connectionsAcross } from "../integration-detail/connections-across";
import { authMethodLabel } from "../../lib/integration-presentation";
import { packageDetailPath } from "../../lib/package-paths";
import { integrationSettingsHref } from "../../lib/settings-section-href";
import { isOauthAuthConnectable } from "../integration-connect/connectable-auth-keys";
import { DetailSectionCard } from "../detail-section-card";
import { SkeletonLine } from "../skeleton-line";
import { OperationalStat } from "../operational-stat";

export function IntegrationOverview({
  packageId,
  detail,
  spaceIds,
  dependentIds,
  onOpenConnections,
  onConfigureAuth,
}: {
  packageId: string;
  detail: IntegrationDetailWire;
  /** The spaces the integration is active in; `undefined` while they load. */
  spaceIds?: readonly string[];
  /** The organization's agents depending on this integration, in every space. */
  dependentIds?: ReadonlyArray<string>;
  onOpenConnections: (authKey?: string) => void;
  /** Omitted for members who cannot configure authentication. */
  onConfigureAuth?: (authKey: string) => void;
}) {
  const { t } = useTranslation("settings");
  const location = useLocation();
  // The agents of the working space, or in « Tous les espaces » of every space reached, each
  // opening in its own: those of another space would answer 404 here.
  const { on } = useOverviewMode();
  const linkInSpace = useSpaceLink();
  const { data: spaceAgents, isLoading: agentsLoading } = useAgents({ spanning: on });
  const agents = dependentIds && spaceAgents?.filter((agent) => dependentIds.includes(agent.id));
  const previewAgent = agents?.[0];
  // In « Tous les espaces » the figures are the reader's own connections across the
  // integration's spaces, as its index card counts them; otherwise the working space's.
  const { data: myConnections } = useMyConnections();
  const orgId = useCurrentOrgId();
  const workingSpace = useSpaceLabelOf()(useCurrentSpaceId());
  const across =
    on && myConnections && spaceIds
      ? connectionsAcross(myConnections, orgId, packageId, spaceIds)
      : undefined;
  const hereConnections = [
    ...new Map(
      detail.auths
        .flatMap((auth) => auth.connections)
        .map((connection) => [connection.id, connection]),
    ).values(),
  ];
  const connectionCount = on ? across?.total : hereConnections.length;
  const reconnect = on
    ? across?.reconnect
    : hereConnections.filter((connection) => connection.needs_reconnection).length;
  const reconnectOf = (auth: IntegrationAuthStatus) =>
    on
      ? (across?.reconnectOf(auth.auth_key) ?? 0)
      : auth.connections.filter((connection) => connection.needs_reconnection).length;
  const figure = (value: number | undefined) =>
    value === undefined ? <SkeletonLine className="w-10" /> : value;
  const available = detail.tool_catalog?.length ?? 0;
  const connectionsTo = { pathname: location.pathname, hash: "#connections" };
  const toolsTo = integrationSettingsHref(location.pathname, "tools");
  const labelFor = (auth: IntegrationAuthStatus) =>
    authMethodLabel(auth, detail.auths, t(`integration.auth.type.${auth.type}`));
  const prepared = (auth: IntegrationAuthStatus) =>
    auth.type !== "oauth2" || isOauthAuthConnectable(auth);
  // An OAuth client is set per space: in the mode the item names the space it is missing in.
  const issues =
    detail.active || on
      ? detail.auths.flatMap((auth) => {
          const items: { key: string; title: string; onClick?: () => void; action: string }[] = [];
          if (detail.active && !prepared(auth))
            items.push({
              key: `setup:${auth.auth_key}`,
              title:
                on && workingSpace
                  ? t("integration.health.setupIn", { method: labelFor(auth), space: workingSpace })
                  : t("integration.health.setup", { method: labelFor(auth) }),
              onClick: onConfigureAuth ? () => onConfigureAuth(auth.auth_key) : undefined,
              action: t("detail.diagnostics.fix", { ns: "agents" }),
            });
          const count = reconnectOf(auth);
          if (count)
            items.push({
              key: `reconnect:${auth.auth_key}`,
              title: t("integration.health.reconnect", { method: labelFor(auth), count }),
              onClick: () => onOpenConnections(auth.auth_key),
              action: t("detail.diagnostics.fix", { ns: "agents" }),
            });
          return items;
        })
      : [];

  return (
    <div className="flex flex-col gap-6" data-testid="integration-overview">
      {issues.length > 0 && (
        <HealthCard
          title={t("integration.health.title")}
          tone="warning"
          badge={
            <HealthIssueBadge>
              {t("integration.health.count", { count: issues.length })}
            </HealthIssueBadge>
          }
        >
          <ul className="divide-y px-4">
            {issues.map((issue) => (
              <HealthCardItem
                key={issue.key}
                title={issue.title}
                description={!issue.onClick ? t("integration.health.adminRequired") : undefined}
                actions={
                  issue.onClick && (
                    <HealthAction onClick={issue.onClick}>{issue.action}</HealthAction>
                  )
                }
              />
            ))}
          </ul>
        </HealthCard>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <DetailSectionCard
          title={t("integration.tabs.connections")}
          icon={Plug}
          bodyClassName="p-0"
        >
          <dl className="divide-y">
            <OperationalStat
              label={t("integration.summary.connections")}
              value={figure(connectionCount)}
              target={connectionCount ? { to: connectionsTo } : undefined}
            />
            <OperationalStat
              label={t("integration.summary.reauthorize")}
              value={figure(reconnect)}
              target={reconnect ? { to: connectionsTo } : undefined}
            />
          </dl>
        </DetailSectionCard>
        <DetailSectionCard
          title={t("integration.summary.agents")}
          icon={Layers}
          bodyClassName="p-0"
        >
          <dl className="divide-y">
            <OperationalStat
              label={t("integration.summary.agentsCount")}
              value={agentsLoading ? <SkeletonLine className="w-10" /> : (agents?.length ?? "—")}
            />
            <OperationalStat
              label={t("integration.summary.agentPreview")}
              value={
                agentsLoading ? (
                  <SkeletonLine className="w-28 text-sm font-medium" />
                ) : (
                  <span
                    className="block truncate text-sm font-medium"
                    title={previewAgent?.display_name || previewAgent?.id}
                  >
                    {previewAgent ? previewAgent.display_name || previewAgent.id : "—"}
                  </span>
                )
              }
              target={
                previewAgent
                  ? {
                      to: linkInSpace(
                        packageDetailPath("agent", previewAgent.id),
                        previewAgent.space_ids,
                      ),
                    }
                  : undefined
              }
            />
          </dl>
        </DetailSectionCard>
        <DetailSectionCard title={t("integration.tabs.tools")} icon={Wrench} bodyClassName="p-0">
          <dl className="divide-y">
            <OperationalStat
              label={t("integration.summary.availableTools")}
              value={available}
              target={available ? { to: toolsTo } : undefined}
            />
          </dl>
        </DetailSectionCard>
      </div>
    </div>
  );
}

/**
 * The integration's overview while it loads: the three summary cards drawn by the same components, labels included. The health
 * card above them only exists when something needs fixing, so it is not drawn.
 */
export function IntegrationOverviewSkeleton() {
  const { t } = useTranslation("settings");
  const value = <SkeletonLine className="w-10" />;
  return (
    <>
      <div className="flex flex-col gap-6">
        <div className="grid items-start gap-4 lg:grid-cols-3">
          <DetailSectionCard
            title={t("integration.tabs.connections")}
            icon={Plug}
            bodyClassName="p-0"
          >
            <dl className="divide-y">
              <OperationalStat label={t("integration.summary.connections")} value={value} />
              <OperationalStat label={t("integration.summary.reauthorize")} value={value} />
            </dl>
          </DetailSectionCard>
          <DetailSectionCard
            title={t("integration.summary.agents")}
            icon={Layers}
            bodyClassName="p-0"
          >
            <dl className="divide-y">
              <OperationalStat label={t("integration.summary.agentsCount")} value={value} />
              <OperationalStat
                label={t("integration.summary.agentPreview")}
                value={<SkeletonLine className="w-28 text-sm font-medium" />}
              />
            </dl>
          </DetailSectionCard>
          <DetailSectionCard title={t("integration.tabs.tools")} icon={Wrench} bodyClassName="p-0">
            <dl className="divide-y">
              <OperationalStat label={t("integration.summary.availableTools")} value={value} />
            </dl>
          </DetailSectionCard>
        </div>
      </div>
    </>
  );
}
