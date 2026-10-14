// SPDX-License-Identifier: Apache-2.0

import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { Badge as StatusPill } from "@appstrate/ui/components/badge";
import { useAgentDiagnostics } from "../../hooks/use-agent-diagnostics";
import { useModalParam } from "../../hooks/use-modal-param";
import { AgentDiagnosticsDialog, AgentDiagnosticsIssueBadge } from "./agent-diagnostics-dialog";
import { agentDiagnosticCorrectionTarget, agentDiagnosticText } from "../../lib/agent-diagnostics";
import { OverviewCardAction } from "../overview-card-action";
import { HealthCard, HealthCardItem, HealthAction } from "../health-card";

/** The agent's diagnostics as the overview's health card: what to fix, what to check. */
export function AgentHealthSection({
  packageId,
  version,
}: {
  packageId: string;
  version?: string;
}) {
  const { t } = useTranslation("agents");
  const location = useLocation();
  const diagnostics = useAgentDiagnostics(packageId, version);
  const result = diagnostics.data;
  const issues = useModalParam("agentIssues");

  if (diagnostics.isLoading) {
    return (
      <section
        className="border-border bg-muted/35 overflow-hidden rounded-lg border"
        aria-label={t("detail.diagnostics.sectionTitle")}
        aria-busy="true"
      >
        <div className="bg-muted/35 flex flex-wrap items-center gap-2 px-4 py-3">
          <span className="bg-muted size-4 animate-pulse rounded" />
          <span className="bg-muted h-4 w-28 animate-pulse rounded" />
          <span className="bg-muted h-5 w-32 animate-pulse rounded-md" />
        </div>
      </section>
    );
  }

  if (result?.status === "healthy") return null;

  const visible = result?.diagnostics.slice(0, 3) ?? [];
  const isUnknown = diagnostics.isError || !result;
  const tone = isUnknown ? "unknown" : result.status;
  const title = isUnknown
    ? t("detail.diagnostics.unknownTitle")
    : result.status === "blocking"
      ? t("detail.diagnostics.blockingTitle", { count: result.blocking_count })
      : t("detail.diagnostics.warningTitle", { count: result.warning_count });
  return (
    <>
      <HealthCard
        title={t("detail.diagnostics.sectionTitle")}
        tone={tone}
        badge={
          result ? (
            <button type="button" onClick={() => issues.open()}>
              <AgentDiagnosticsIssueBadge result={result} />
            </button>
          ) : (
            <StatusPill variant="pending">{title}</StatusPill>
          )
        }
      >
        <div className="px-4">
          {result?.status === "blocking" && result.warning_count > 0 && (
            <p className="text-muted-foreground pt-4 text-xs">
              {t("detail.diagnostics.warningAlongside", { count: result.warning_count })}
            </p>
          )}

          {visible.length > 0 && (
            <ul
              className={cn(
                "divide-y",
                result?.status === "blocking" && result.warning_count > 0 && "mt-3",
              )}
            >
              {visible.map((diagnostic) => {
                const text = agentDiagnosticText(diagnostic, t);
                const target = agentDiagnosticCorrectionTarget(diagnostic, location.pathname);
                return (
                  <HealthCardItem
                    key={`${diagnostic.code}:${diagnostic.field}`}
                    title={text.title}
                    description={text.explanation}
                    actions={
                      target && (
                        <HealthAction to={target}>{t("detail.diagnostics.fix")}</HealthAction>
                      )
                    }
                  />
                );
              })}
            </ul>
          )}
        </div>
        {result && result.diagnostics.length > 3 && (
          <OverviewCardAction onClick={() => issues.open()}>
            {t("detail.diagnostics.seeAll")}
          </OverviewCardAction>
        )}
      </HealthCard>
      <AgentDiagnosticsDialog result={result} open={issues.value !== null} onClose={issues.close} />
    </>
  );
}
