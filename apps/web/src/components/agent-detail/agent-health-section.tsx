// SPDX-License-Identifier: Apache-2.0

import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAppConfig } from "../../hooks/use-app-config";
import { cn } from "@appstrate/ui/cn";
import { Badge as StatusPill } from "@appstrate/ui/components/badge";
import { useAgentDiagnostics } from "../../hooks/use-agent-diagnostics";
import { useModalParam } from "../../hooks/use-modal-param";
import { AgentDiagnosticsDialog, AgentDiagnosticsIssueBadge } from "./agent-diagnostics-dialog";
import {
  agentDiagnosticCorrectionTarget,
  agentDiagnosticLocateTarget,
  agentDiagnosticText,
} from "../../lib/agent-diagnostics";
import { OverviewCardAction } from "../overview-card-action";
import { HealthCard, HealthCardItem, HealthAction } from "../health-card";

/** The agent's diagnostics as the overview's health card: what to fix, what to check. */
export function AgentHealthSection({
  packageId,
  version,
  cardHeaders = false,
}: {
  packageId: string;
  version?: string;
  cardHeaders?: boolean;
}) {
  const { t } = useTranslation("agents");
  const location = useLocation();
  const { features } = useAppConfig();
  const diagnostics = useAgentDiagnostics(packageId, version);
  const result = diagnostics.data;
  const issues = useModalParam("agentIssues");

  if (diagnostics.isLoading) {
    return (
      <section
        className={cn(
          "border-border rounded-lg border",
          cardHeaders && "bg-muted/35",
          cardHeaders ? "overflow-hidden" : "p-4",
        )}
        aria-label={t("detail.diagnostics.sectionTitle")}
        aria-busy="true"
      >
        <div
          className={cn(
            "flex flex-wrap items-center gap-2",
            cardHeaders && "bg-muted/35 px-4 py-3",
          )}
        >
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
        cardHeaders={cardHeaders}
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
        <div className={cn(cardHeaders && "px-4")}>
          {result?.status === "blocking" && result.warning_count > 0 && (
            <p className="text-muted-foreground pt-4 text-xs">
              {t("detail.diagnostics.warningAlongside", { count: result.warning_count })}
            </p>
          )}

          {visible.length > 0 && (
            <ul
              className={cn(
                "divide-y",
                !cardHeaders && "mt-3",
                cardHeaders && result?.status === "blocking" && result.warning_count > 0 && "mt-3",
              )}
            >
              {visible.map((diagnostic) => {
                const text = agentDiagnosticText(diagnostic, t);
                return (
                  <HealthCardItem
                    key={`${diagnostic.code}:${diagnostic.field}`}
                    title={text.title}
                    description={text.explanation}
                    cardHeaders={cardHeaders}
                    actions={
                      <>
                        <HealthAction
                          to={agentDiagnosticCorrectionTarget(
                            diagnostic,
                            location.pathname,
                            location.search,
                          )}
                        >
                          {t("detail.diagnostics.fix")}
                        </HealthAction>
                        {/* "Locate" opens the map, served by the opt-in agent-map module. */}
                        {features.agentMap && (
                          <HealthAction
                            to={agentDiagnosticLocateTarget(
                              diagnostic,
                              location.pathname,
                              location.search,
                            )}
                            secondary
                          >
                            {t("detail.diagnostics.locate")}
                          </HealthAction>
                        )}
                      </>
                    }
                  />
                );
              })}
            </ul>
          )}

          {result && result.diagnostics.length > 3 && !cardHeaders && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => issues.open()}
                className="text-primary text-xs font-medium hover:underline"
              >
                {t("detail.diagnostics.seeAll")}
              </button>
            </div>
          )}
        </div>
        {result && result.diagnostics.length > 3 && cardHeaders && (
          <OverviewCardAction onClick={() => issues.open()}>
            {t("detail.diagnostics.seeAll")}
          </OverviewCardAction>
        )}
      </HealthCard>
      <AgentDiagnosticsDialog result={result} open={issues.value !== null} onClose={issues.close} />
    </>
  );
}
