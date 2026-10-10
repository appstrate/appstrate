// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import { useIntegrationDetail } from "../../hooks/use-integrations";
import { useCanReach } from "../../hooks/use-can-reach";
import { HealthAction, HealthCard, HealthCardItem } from "../health-card";
import { artifactFailureCodeKey, partialArtifactFailures } from "../run-artifacts";

/**
 * Safe-narrow `runs.metadata.degraded_integrations` (a `string[]` of
 * integration package ids stamped platform-side by `recordRunDegradedIntegration`
 * when the `/internal/.../refresh` call flags a connection on a terminal 401)
 * out of the untyped `run.metadata` blob.
 */
function parseDegradedIntegrations(metadata: unknown): string[] {
  if (metadata == null || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).degraded_integrations;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

function DegradedIntegrationItem({
  integrationId,
  cardHeaders,
}: {
  integrationId: string;
  cardHeaders: boolean;
}) {
  const { t } = useTranslation("common");
  const { data } = useIntegrationDetail(integrationId);
  const canReach = useCanReach();
  const integrationPath = `/integrations/${integrationId}`;
  return (
    <HealthCardItem
      title={data?.manifest.display_name ?? integrationId}
      cardHeaders={cardHeaders}
      actions={
        canReach(integrationPath) ? (
          <HealthAction to={integrationPath}>{t("btn.reconnect")}</HealthAction>
        ) : null
      }
    />
  );
}

/**
 * What the run left behind without failing, told in its overview with the
 * problem that ended it (never a banner: a finished run is history, not a
 * present state to act on). Two cases, each a warning card:
 *
 * - an integration hit a terminal auth failure (a 401 that survived the
 *   proxy's refresh and retry): the agent lost a tool mid-run, and each row
 *   leads to the integration's page where the reconnect lives;
 * - the outputs sweep ended `partial`: deliverables were LOST (upload
 *   abandoned after retries, a file over the per-file cap) while the run itself
 *   may well have SUCCEEDED, so this is the only place a green run says it.
 */
export function RunWarnings({ run, cardHeaders }: { run: EnrichedRun; cardHeaders: boolean }) {
  const { t } = useTranslation("agents");
  const degraded = parseDegradedIntegrations(run.metadata);
  const lost = partialArtifactFailures(run.artifacts);
  const intro = cardHeaders
    ? "text-muted-foreground px-4 pt-3 text-xs"
    : "text-muted-foreground mt-3 text-xs";
  const list = cardHeaders ? "px-4" : "mt-1";
  return (
    <>
      {degraded.length > 0 && (
        <div className="mb-6">
          <HealthCard
            title={t("run.degradedIntegrations.title")}
            tone="warning"
            cardHeaders={cardHeaders}
            badge={null}
          >
            <p className={intro}>{t("run.degradedIntegrations.message")}</p>
            <ul className={list}>
              {degraded.map((id) => (
                <DegradedIntegrationItem key={id} integrationId={id} cardHeaders={cardHeaders} />
              ))}
            </ul>
          </HealthCard>
        </div>
      )}
      {lost && (
        <div className="mb-6">
          <HealthCard
            title={t("run.artifacts.partial.title")}
            tone="warning"
            cardHeaders={cardHeaders}
            badge={null}
          >
            <p className={intro}>{t("run.artifacts.partial.message")}</p>
            <ul className={list}>
              {lost.map((file) => (
                <HealthCardItem
                  key={file.name}
                  title={<span className="font-mono text-xs break-all">{file.name}</span>}
                  description={t(artifactFailureCodeKey(file.code))}
                  cardHeaders={cardHeaders}
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
