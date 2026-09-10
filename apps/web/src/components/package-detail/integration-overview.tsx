// SPDX-License-Identifier: Apache-2.0

import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Layers, Plug, Wrench } from "lucide-react";
import { HealthCard, HealthCardItem, HealthAction, HealthIssueBadge } from "../health-card";
import type { IntegrationDetailWire, IntegrationAuthStatus } from "../../hooks/use-integrations";
import { authMethodLabel } from "../../lib/integration-presentation";
import { packageDetailPath } from "../../lib/package-paths";
import { isOauthAuthConnectable } from "../integration-connect/connectable-auth-keys";
import { DetailSectionCard } from "../detail-section-card";
import { OperationalStat } from "../operational-stat";

export function IntegrationOverview({
  detail,
  agents,
  onOpenConnections,
  onConfigureAuth,
}: {
  detail: IntegrationDetailWire;
  agents?: ReadonlyArray<{ id: string; display_name?: string }>;
  onOpenConnections: (authKey?: string) => void;
  /** Omitted for members who cannot configure authentication. */
  onConfigureAuth?: (authKey: string) => void;
}) {
  const { t } = useTranslation("settings");
  const location = useLocation();
  const previewAgent = agents?.[0];
  const connections = [
    ...new Map(
      detail.auths
        .flatMap((auth) => auth.connections)
        .map((connection) => [connection.id, connection]),
    ).values(),
  ];
  const reconnect = connections.filter((connection) => connection.needs_reconnection).length;
  const available = detail.tool_catalog?.length ?? 0;
  const hidden = detail.tool_catalog_inspection?.entries.filter(
    (tool) => tool.exposure === "hidden",
  ).length;
  const connectionsTo = { pathname: location.pathname, hash: "#connections" };
  const toolsParams = new URLSearchParams(location.search);
  toolsParams.set("integrationSettings", "tools");
  const toolsTo = {
    pathname: location.pathname,
    search: toolsParams.toString(),
    hash: "#configuration",
  };
  const labelFor = (auth: IntegrationAuthStatus) =>
    authMethodLabel(auth, detail.auths, t(`integration.auth.type.${auth.type}`));
  const prepared = (auth: IntegrationAuthStatus) =>
    auth.type !== "oauth2" || isOauthAuthConnectable(auth);
  const issues = detail.active
    ? detail.auths.flatMap((auth) => {
        const items: { key: string; title: string; onClick?: () => void; action: string }[] = [];
        if (!prepared(auth))
          items.push({
            key: `setup:${auth.auth_key}`,
            title: t("integration.health.setup", { method: labelFor(auth) }),
            onClick: onConfigureAuth ? () => onConfigureAuth(auth.auth_key) : undefined,
            action: t("detail.diagnostics.fix", { ns: "agents" }),
          });
        const count = auth.connections.filter((connection) => connection.needs_reconnection).length;
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
    <div className="space-y-6" data-testid="integration-overview">
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
          headerInside
          title={t("integration.tabs.connections")}
          icon={Plug}
          bodyClassName="p-0"
        >
          <dl className="divide-y">
            <OperationalStat
              label={t("integration.summary.connections")}
              value={connections.length}
              to={connections.length ? connectionsTo : undefined}
            />
            <OperationalStat
              label={t("integration.summary.reauthorize")}
              value={reconnect}
              to={reconnect ? connectionsTo : undefined}
            />
          </dl>
        </DetailSectionCard>
        <DetailSectionCard
          headerInside
          title={t("integration.summary.agents")}
          icon={Layers}
          bodyClassName="p-0"
        >
          <dl className="divide-y">
            <OperationalStat
              label={t("integration.summary.agentsCount")}
              value={agents?.length ?? "—"}
            />
            <OperationalStat
              label={t("integration.summary.agentPreview")}
              value={
                <span
                  className="block truncate text-sm font-medium"
                  title={previewAgent?.display_name || previewAgent?.id}
                >
                  {previewAgent ? previewAgent.display_name || previewAgent.id : "—"}
                </span>
              }
              to={previewAgent ? packageDetailPath("agent", previewAgent.id) : undefined}
            />
          </dl>
        </DetailSectionCard>
        <DetailSectionCard
          headerInside
          title={t("integration.tabs.tools")}
          icon={Wrench}
          bodyClassName="p-0"
        >
          <dl className="divide-y">
            <OperationalStat
              label={t("integration.summary.availableTools")}
              value={available}
              to={available ? toolsTo : undefined}
            />
            <OperationalStat
              label={t("integration.summary.hiddenTools")}
              value={hidden ?? "—"}
              to={hidden ? toolsTo : undefined}
            />
          </dl>
        </DetailSectionCard>
      </div>
    </div>
  );
}
