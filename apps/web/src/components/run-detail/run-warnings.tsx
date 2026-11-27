// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { To } from "react-router-dom";
import type { EnrichedRun } from "@appstrate/shared-types";
import { useIntegrationName } from "../../hooks/use-integration-name";
import { useCanReach } from "../../hooks/use-can-reach";
import { useModels } from "../../hooks/use-models";
import { useMyConnections } from "../../hooks/use-me-connections";
import { useHostedConnectPopup } from "../integration-connect/use-hosted-connect-popup";
import { usePermissions } from "../../hooks/use-permissions";
import type { RunModelFallback } from "../../lib/run-model-fallback";
import { packageDetailPath } from "../../lib/package-paths";
import { agentSettingsHref, integrationSettingsHref } from "../../lib/settings-section-href";
import { HealthAction, HealthCard, HealthCardItem } from "../health-card";
import { artifactFailureCodeKey, partialArtifactFailures } from "../run-artifacts";
import { MetaBadge } from "../status-badge";
import {
  isRunDegraded,
  parseDegradedIntegrations,
  parseScopeRequests,
  parseUnavailableTools,
  unavailableReasonKey,
  type ScopeRequest,
  type UnavailableTool,
} from "../../lib/run-degradation";

/** « dégradé » next to a run's status: the run finished, but without something it needed. */
export function RunDegradedBadge({ metadata }: { metadata: unknown }) {
  const { t } = useTranslation("agents");
  if (!isRunDegraded(metadata)) return null;
  return <MetaBadge label={t("run.degraded.badge")} title={t("run.degraded.hint")} />;
}

/** The reasons a space's decision settles: its integration's Outils section is where it is taken. */
const SETTLED_IN_TOOLS_SECTION: ReadonlySet<UnavailableTool["reason"]> = new Set([
  "blocked_in_space",
  "definition_not_approved",
]);

function UnavailableToolItem({ tool }: { tool: UnavailableTool }) {
  const { t } = useTranslation("agents");
  const displayName = useIntegrationName(tool.integrationId);
  const canReach = useCanReach();
  const toolsPath = SETTLED_IN_TOOLS_SECTION.has(tool.reason)
    ? integrationSettingsHref(packageDetailPath("integration", tool.integrationId), "tools")
    : null;
  return (
    <HealthCardItem
      title={<span className="font-mono text-xs break-all">{tool.name}</span>}
      description={`${displayName} · ${t(unavailableReasonKey(tool.reason))}`}
      actions={
        toolsPath && canReach(toolsPath) ? (
          <HealthAction to={toolsPath}>{t("run.unavailableTools.manage")}</HealthAction>
        ) : null
      }
    />
  );
}

function DegradedIntegrationItem({ integrationId }: { integrationId: string }) {
  const { t } = useTranslation("common");
  const displayName = useIntegrationName(integrationId);
  const canReach = useCanReach();
  const integrationPath = packageDetailPath("integration", integrationId);
  return (
    <HealthCardItem
      title={displayName}
      actions={
        canReach(integrationPath) ? (
          <HealthAction to={integrationPath}>{t("btn.reconnect")}</HealthAction>
        ) : null
      }
    />
  );
}

/**
 * The reconnect that grants the scopes is the connection owner's: only their own list holds it.
 * The run's record is history; the action follows the connection's standing demand, so a grant
 * made since leaves nothing to offer.
 */
function ScopeRequestItem({ request }: { request: ScopeRequest }) {
  const { t } = useTranslation(["agents", "settings"]);
  const displayName = useIntegrationName(request.integrationId);
  const { data: groups } = useMyConnections();
  const { openPopup } = useHostedConnectPopup();
  const owned = groups
    ?.flatMap((g) => g.connections)
    .find((c) => c.connection_id === request.connectionId);
  const spaceId = owned?.reconnect_space_id;
  const standing = owned?.requested_scopes ?? [];
  return (
    <HealthCardItem
      title={displayName}
      description={`${owned ? `${owned.label} · ` : ""}${request.scopes.join(", ")}`}
      actions={
        owned && spaceId && standing.length > 0 ? (
          <HealthAction
            onClick={() =>
              void openPopup({
                packageId: request.integrationId,
                authKey: owned.auth_key,
                connectionId: request.connectionId,
                scopes: standing,
                space: { orgId: owned.org.id, spaceId },
              })
            }
          >
            {t("integration.connection.reconnectWithScopes", { ns: "settings" })}
          </HealthAction>
        ) : null
      }
    />
  );
}

/** The chosen model did not load; the org default served. `chosen` is a name (raw id if gone); `settingsTo` null when unreachable. */
export function ModelFallbackCard({
  chosen,
  used,
  settingsTo,
}: {
  chosen: string;
  used: string;
  settingsTo: To | null;
}) {
  const { t } = useTranslation("agents");
  return (
    <RunWarningCard title={t("run.modelFallback.title")} message={t("run.modelFallback.message")}>
      <HealthCardItem
        title={t("run.modelFallback.chosen", { model: chosen })}
        description={t("run.modelFallback.used", { model: used })}
        actions={
          settingsTo ? (
            <HealthAction to={settingsTo}>{t("run.modelFallback.change")}</HealthAction>
          ) : null
        }
      />
    </RunWarningCard>
  );
}

function ResolvedModelFallback({
  run,
  fallback,
}: {
  run: EnrichedRun;
  fallback: RunModelFallback;
}) {
  const canReach = useCanReach();
  const { data: models } = useModels(usePermissions().can("models:read"));
  const agentPath = packageDetailPath("agent", `${run.agent_scope}/${run.agent_name}`);
  const reachable = !run.package_ephemeral && canReach(agentPath);
  return (
    <ModelFallbackCard
      chosen={models?.find((m) => m.id === fallback.pinnedModelId)?.label ?? fallback.pinnedModelId}
      used={fallback.model}
      settingsTo={reachable ? agentSettingsHref(agentPath, "model") : null}
    />
  );
}

/** One warning card of a run: a title, what it means, then one item per finding. */
function RunWarningCard({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-6">
      <HealthCard title={title} tone="warning" badge={null}>
        <p className="text-muted-foreground px-4 pt-3 text-xs">{message}</p>
        <ul className="px-4">{children}</ul>
      </HealthCard>
    </div>
  );
}

/**
 * What the run left behind without failing, as warning cards (never a banner: a finished run is
 * history): model fallback; an integration's terminal auth failure (401 surviving refresh);
 * scopes a server asked for that a connection of the run does not hold (the owner reconnects with them);
 * tools the agent asked for that the run could not serve; a `partial` outputs sweep, where deliverables were LOST though the run may have SUCCEEDED.
 */
export function RunWarnings({
  run,
  modelFallback,
}: {
  run: EnrichedRun;
  modelFallback: RunModelFallback | null;
}) {
  const { t } = useTranslation("agents");
  const degraded = parseDegradedIntegrations(run.metadata);
  const unavailable = parseUnavailableTools(run.metadata);
  const scopeRequests = parseScopeRequests(run.metadata);
  const lost = partialArtifactFailures(run.artifacts);
  return (
    <>
      {modelFallback && <ResolvedModelFallback run={run} fallback={modelFallback} />}
      {degraded.length > 0 && (
        <RunWarningCard
          title={t("run.degradedIntegrations.title")}
          message={t("run.degradedIntegrations.message")}
        >
          {degraded.map((id) => (
            <DegradedIntegrationItem key={id} integrationId={id} />
          ))}
        </RunWarningCard>
      )}
      {scopeRequests.length > 0 && (
        <RunWarningCard
          title={t("run.scopeRequests.title")}
          message={t("run.scopeRequests.message")}
        >
          {scopeRequests.map((request) => (
            <ScopeRequestItem
              key={`${request.integrationId}:${request.connectionId}`}
              request={request}
            />
          ))}
        </RunWarningCard>
      )}
      {unavailable.length > 0 && (
        <RunWarningCard
          title={t("run.unavailableTools.title")}
          message={t("run.unavailableTools.message")}
        >
          {unavailable.map((tool) => (
            <UnavailableToolItem key={`${tool.integrationId}:${tool.name}`} tool={tool} />
          ))}
        </RunWarningCard>
      )}
      {lost && (
        <RunWarningCard
          title={t("run.artifacts.partial.title")}
          message={t("run.artifacts.partial.message")}
        >
          {lost.map((file) => (
            <HealthCardItem
              key={file.name}
              title={<span className="font-mono text-xs break-all">{file.name}</span>}
              description={t(artifactFailureCodeKey(file.code))}
              actions={null}
            />
          ))}
        </RunWarningCard>
      )}
    </>
  );
}
