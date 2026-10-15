// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { To } from "react-router-dom";
import type { EnrichedRun } from "@appstrate/shared-types";
import { useIntegrationName } from "../../hooks/use-integration-name";
import { useCanReach } from "../../hooks/use-can-reach";
import { useModels } from "../../hooks/use-models";
import { usePermissions } from "../../hooks/use-permissions";
import type { RunModelFallback } from "../../lib/run-model-fallback";
import { agentSettingsHref } from "../../lib/settings-section-href";
import { HealthAction, HealthCard, HealthCardItem } from "../health-card";
import { artifactFailureCodeKey, partialArtifactFailures } from "../run-artifacts";

/** Safe-narrows `runs.metadata.degraded_integrations` (integration ids, stamped on a terminal 401 at refresh). */
function parseDegradedIntegrations(metadata: unknown): string[] {
  if (metadata == null || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).degraded_integrations;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

function DegradedIntegrationItem({ integrationId }: { integrationId: string }) {
  const { t } = useTranslation("common");
  const displayName = useIntegrationName(integrationId);
  const canReach = useCanReach();
  const integrationPath = `/integrations/${integrationId}`;
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
    <div className="mb-6">
      <HealthCard title={t("run.modelFallback.title")} tone="warning" badge={null}>
        <p className="text-muted-foreground px-4 pt-3 text-xs">{t("run.modelFallback.message")}</p>
        <ul className="px-4">
          <HealthCardItem
            title={t("run.modelFallback.chosen", { model: chosen })}
            description={t("run.modelFallback.used", { model: used })}
            actions={
              settingsTo ? (
                <HealthAction to={settingsTo}>{t("run.modelFallback.change")}</HealthAction>
              ) : null
            }
          />
        </ul>
      </HealthCard>
    </div>
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
  const agentPath = `/agents/${run.agent_scope}/${run.agent_name}`;
  const reachable = !run.package_ephemeral && canReach(agentPath);
  return (
    <ModelFallbackCard
      chosen={models?.find((m) => m.id === fallback.pinnedModelId)?.label ?? fallback.pinnedModelId}
      used={fallback.model}
      settingsTo={reachable ? agentSettingsHref(agentPath, "model") : null}
    />
  );
}

/**
 * What the run left behind without failing, as warning cards (never a banner: a finished run is
 * history): model fallback; an integration's terminal auth failure (401 surviving refresh);
 * a `partial` outputs sweep, where deliverables were LOST though the run may have SUCCEEDED.
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
  const lost = partialArtifactFailures(run.artifacts);
  return (
    <>
      {modelFallback && <ResolvedModelFallback run={run} fallback={modelFallback} />}
      {degraded.length > 0 && (
        <div className="mb-6">
          <HealthCard title={t("run.degradedIntegrations.title")} tone="warning" badge={null}>
            <p className="text-muted-foreground px-4 pt-3 text-xs">
              {t("run.degradedIntegrations.message")}
            </p>
            <ul className="px-4">
              {degraded.map((id) => (
                <DegradedIntegrationItem key={id} integrationId={id} />
              ))}
            </ul>
          </HealthCard>
        </div>
      )}
      {lost && (
        <div className="mb-6">
          <HealthCard title={t("run.artifacts.partial.title")} tone="warning" badge={null}>
            <p className="text-muted-foreground px-4 pt-3 text-xs">
              {t("run.artifacts.partial.message")}
            </p>
            <ul className="px-4">
              {lost.map((file) => (
                <HealthCardItem
                  key={file.name}
                  title={<span className="font-mono text-xs break-all">{file.name}</span>}
                  description={t(artifactFailureCodeKey(file.code))}
                  actions={null}
                />
              ))}
            </ul>
          </HealthCard>
        </div>
      )}
    </>
  );
}
