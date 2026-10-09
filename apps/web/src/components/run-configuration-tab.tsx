// SPDX-License-Identifier: Apache-2.0

/**
 * Run-detail "Configuration" pane — how the run was SET UP, before it ran:
 * which agent and which version of it, what triggered it, which connections it
 * was wired to, and — for an inline run, whose whole definition is the launch —
 * the prompt and manifest snapshot it carried.
 *
 * Everything here is a property of the definition, not of this particular
 * execution: it answers "why would another run of this behave the same way?",
 * where the Exécution pane answers "what did THIS one do?".
 */

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useCanReach } from "../hooks/use-can-reach";
import { FileCode2 } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Badge } from "@appstrate/ui/components/badge";
import { JsonView } from "./json-view";
import { SectionCard } from "./section-card";
import { InfoCard } from "./run-info-card";
import { EmptyState } from "./page-states";
import { RunTrigger } from "./run-trigger";
import { inlineRunDisplayName } from "../lib/run-title";
import { groupByIntegration } from "../lib/run-connections";
import { causeSentence } from "../lib/launch-warnings";
import type { EnrichedRun } from "@appstrate/shared-types";

interface RunConfigurationTabProps {
  run: EnrichedRun;
  /** Catalog display name of the source agent, when the page resolved one. */
  agentName?: string;
}

export function RunConfigurationTab({ run, agentName }: RunConfigurationTabProps) {
  const { t } = useTranslation(["agents", "settings"]);
  // Why each integration started without a connection, in the launch toast's words.
  const unboundCause = new Map(
    (run.integrations_unbound ?? []).map((u) => [u.integration_package_id, causeSentence(u)]),
  );
  const connectionRows = groupByIntegration(run.connections_used ?? [], [...unboundCause.keys()]);
  const isInline = run.package_ephemeral;
  // Source agent deleted (FK SET NULL after migration 0017): the run row
  // survives but the agent page it would link to is gone.
  const isOrphaned = run.packageId == null && !isInline;
  const agentPath = `/agents/${run.packageId}`;
  const canReach = useCanReach();

  const agentValue = isInline ? (
    inlineRunDisplayName(run.agent_name, t("runs.inlineBadge"))
  ) : isOrphaned ? (
    <span className="text-muted-foreground italic">{t("runs.deletedAgent")}</span>
  ) : canReach(agentPath) ? (
    <Link className="hover:underline" to={agentPath}>
      {agentName || run.packageId}
    </Link>
  ) : (
    agentName || run.packageId
  );

  return (
    <div className="space-y-4">
      {/* Agent + Version + Trigger — inline runs are not versioned, so the
          Version card is simply absent for them and the grid reflows. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <InfoCard label={t("run.infoAgent")} value={agentValue} />
        {!isInline && (
          <InfoCard
            label={t("run.infoVersion")}
            value={
              <span className={cn("font-mono", run.version_ref === "draft" && "italic")}>
                {/* version_ref is unambiguous (#636): a concrete semver when the
                    run executed a published definition, "draft" otherwise. For
                    draft runs, surface the published base version when known. */}
                {run.version_ref !== "draft"
                  ? `v${run.version_ref}`
                  : run.version_label && run.version_label !== "draft"
                    ? `${t("run.draft")} (v${run.version_label} ${t("run.versionModified")})`
                    : t("run.draft")}
              </span>
            }
          />
        )}
        <InfoCard label={t("run.infoTrigger")} value={<RunTrigger run={run} />} />
      </div>

      {/* Connexions — connections resolved for this run, denormalized at
          kickoff so the panel survives a connection rename/deletion, and the
          declared integrations the run started without. */}
      {connectionRows.length > 0 && (
        <SectionCard title={t("run.infoConnections")}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* One card per integration, listing every connection it bound. */}
            {connectionRows.map(([integrationId, bound]) => (
              <InfoCard
                key={integrationId}
                label={integrationId}
                value={
                  bound.length === 0 ? (
                    <span
                      className="text-muted-foreground flex flex-col"
                      data-testid={`run-integration-unbound-${integrationId}`}
                    >
                      <span>{t("run.integrationUnbound")}</span>
                      <span className="text-xs">{unboundCause.get(integrationId)}</span>
                    </span>
                  ) : (
                    <span className="flex flex-col gap-1.5">
                      {bound.map((c, i) => (
                        <span key={`${c.label}-${i}`} className="flex flex-col">
                          <span className="flex items-center gap-1.5">
                            <span>{c.label}</span>
                            <Badge variant="secondary" className="text-[0.6rem]">
                              {t(`run.connSource.${c.source}`, { defaultValue: c.source })}
                            </Badge>
                          </span>
                          <span className="text-muted-foreground text-xs">{c.account_id}</span>
                        </span>
                      ))}
                    </span>
                  )
                }
              />
            ))}
          </div>
        </SectionCard>
      )}

      {/* Inline run — prompt + manifest snapshot (null after compaction). This
          IS the inline run's configuration: there is no catalog entry to open. */}
      {isInline && (
        <>
          {run.inline_prompt ? (
            <SectionCard title={t("run.sectionPrompt")}>
              <pre className="bg-muted/30 overflow-x-auto rounded-md p-4 font-mono text-xs whitespace-pre-wrap">
                {run.inline_prompt}
              </pre>
            </SectionCard>
          ) : null}
          {run.inline_manifest ? (
            <SectionCard title={t("run.sectionManifest")}>
              <JsonView data={run.inline_manifest} />
            </SectionCard>
          ) : null}
          {!run.inline_prompt && !run.inline_manifest && (
            <EmptyState message={t("runs.detailsExpired")} icon={FileCode2} compact />
          )}
        </>
      )}
    </div>
  );
}
