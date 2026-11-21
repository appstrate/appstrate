// SPDX-License-Identifier: Apache-2.0

import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Layers, Plug, Share2, Wrench } from "lucide-react";
import { HealthCard, HealthCardItem, HealthAction, HealthIssueBadge } from "../health-card";
import type { IntegrationDetailWire, IntegrationAuthStatus } from "../../hooks/use-integrations";
import { useAgents } from "../../hooks/use-packages";
import { useOverviewMode, useWorkingSpaceWording } from "../../hooks/use-overview-mode";
import { useSpaceLink } from "../../hooks/use-current-space";
import { useMyConnections } from "../../hooks/use-me-connections";
import { useCurrentOrgId } from "../../hooks/use-org";
import { connectionsInSpaces } from "../../lib/connection-count";
import { authMethodLabel } from "../../lib/integration-presentation";
import { packageDetailPath } from "../../lib/package-paths";
import { availabilityLabel } from "../../lib/integration-availability";
import { integrationSettingsHref } from "../../lib/settings-section-href";
import { isOauthAuthConnectable } from "../integration-connect/connectable-auth-keys";
import { DetailSectionCard } from "../detail-section-card";
import { SkeletonLine } from "../skeleton-line";
import { OperationalStat } from "../operational-stat";
import { OrgOfferRow } from "../org-offer-row";
import { useCatalogueEntry } from "./catalogue-link";

/**
 * Whether the working space runs the integration and how it got there, then what the reader may
 * do about the organization offer and the sharing into other spaces (the catalogue's sheet).
 * Activation itself stays the header's button.
 */
function AvailabilityCard({
  packageId,
  detail,
}: {
  packageId: string;
  detail: IntegrationDetailWire;
}) {
  const { t } = useTranslation("settings");
  const catalogue = useCatalogueEntry("integration", packageId);
  const { key, params } = availabilityLabel(detail.availability);
  const { offered_to_org, org_offerable, active_by_default } = detail.availability;
  return (
    <DetailSectionCard
      title={t("integration.availability.title")}
      icon={Share2}
      bodyClassName="p-0"
    >
      <dl className="divide-y">
        <OperationalStat
          label={t("integration.availability.here")}
          value={t(key, params)}
          size="sm"
        />
      </dl>
      {(offered_to_org || org_offerable || active_by_default || catalogue) && (
        <div className="flex flex-col gap-3 border-t p-4">
          <OrgOfferRow
            item={{
              id: packageId,
              name: detail.manifest.display_name ?? packageId,
              offered_to_org,
              org_offerable,
              active_by_default,
            }}
          />
          {catalogue && (
            <Link
              to={catalogue.to}
              state={catalogue.state}
              className="text-primary w-fit text-sm font-medium hover:underline"
            >
              {catalogue.label}
            </Link>
          )}
        </div>
      )}
    </DetailSectionCard>
  );
}

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
  const { data: myConnections } = useMyConnections(on);
  const orgId = useCurrentOrgId();
  const spaceWording = useWorkingSpaceWording("settings");
  const across =
    on && myConnections && spaceIds
      ? connectionsInSpaces(
          myConnections.find((group) => group.source_id === packageId)?.connections ?? [],
          orgId,
          spaceIds,
        )
      : undefined;
  const hereConnections = [
    ...new Map(
      detail.auths
        .flatMap((auth) => auth.connections)
        .map((connection) => [connection.id, connection]),
    ).values(),
  ];
  const connections = on ? across : hereConnections;
  const connectionCount = connections?.length;
  const reconnect = connections?.filter((connection) => connection.needs_reconnection).length;
  const reconnectOf = (auth: IntegrationAuthStatus) =>
    (on
      ? across?.filter((connection) => connection.auth_key === auth.auth_key)
      : auth.connections
    )?.filter((connection) => connection.needs_reconnection).length ?? 0;
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
              title: spaceWording("integration.health.setup", "integration.health.setupIn", {
                method: labelFor(auth),
              }),
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
      {/* The working space's: « Tous les espaces » has none to say. */}
      {!on && <AvailabilityCard packageId={packageId} detail={detail} />}
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
          {/* An integration declaring no auths (AFPS §7.2) binds no connection: nothing to count. */}
          {detail.auths.length === 0 ? (
            <p className="text-muted-foreground px-4 py-4 text-sm">{t("integration.auth.none")}</p>
          ) : (
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
          )}
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
 * The integration's overview while it loads: the availability card (out of the mode) and the three summary cards drawn by the same components, labels included. The health
 * card above them only exists when something needs fixing, so it is not drawn.
 */
export function IntegrationOverviewSkeleton() {
  const { t } = useTranslation("settings");
  const { on } = useOverviewMode();
  const value = <SkeletonLine className="w-10" />;
  return (
    <>
      <div className="flex flex-col gap-6">
        {/* Drawn out of « Tous les espaces », where the card exists. */}
        {!on && (
          <DetailSectionCard
            title={t("integration.availability.title")}
            icon={Share2}
            bodyClassName="p-0"
          >
            <dl className="divide-y">
              <OperationalStat
                label={t("integration.availability.here")}
                value={<SkeletonLine className="w-40 text-sm" />}
                size="sm"
              />
            </dl>
          </DetailSectionCard>
        )}
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
