// SPDX-License-Identifier: Apache-2.0

/** One diagnostic list for every Agent projection. */

import type { ReactNode } from "react";
import { useAppConfig } from "../../hooks/use-app-config";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { HealthIssueBadge } from "../health-card";
import { Modal } from "../modal";
import type { AgentDiagnostics } from "../../hooks/use-agent-diagnostics";
import {
  agentDiagnosticCorrectionTarget,
  agentDiagnosticKey,
  agentDiagnosticLocateTarget,
  agentDiagnosticText,
  agentDiagnosticsTitle,
} from "../../lib/agent-diagnostics";

export function AgentDiagnosticsIssueBadge({
  result,
  className,
}: {
  result: AgentDiagnostics;
  className?: string;
}) {
  const { t } = useTranslation("agents");
  if (result.status === "healthy") return null;
  return (
    <HealthIssueBadge blocking={result.status === "blocking"} className={className}>
      {agentDiagnosticsTitle(result, t)}
    </HealthIssueBadge>
  );
}

/** A link that leaves the URL dialog it sits in for `to`, in one navigation; a modified click opens a new tab. */
function LeaveLink({
  to,
  onLeave,
  className,
  children,
}: {
  to: string;
  onLeave: (to: string) => void;
  className: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onLeave(to);
      }}
      className={className}
    >
      {children}
    </Link>
  );
}

export function AgentDiagnosticsDialog({
  result,
  open,
  onClose,
  onLeave,
}: {
  result: AgentDiagnostics | undefined;
  open: boolean;
  onClose: () => void;
  /** Leaves the dialog for the section that corrects a diagnostic, in one navigation. */
  onLeave: (to: string) => void;
}) {
  const { t } = useTranslation("agents");
  const location = useLocation();
  const { features } = useAppConfig();
  if (!open || !result) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={t("detail.diagnostics.sectionTitle")}
      className="sm:max-w-2xl"
    >
      <div className="flex max-h-[60vh] flex-col overflow-y-auto">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <AgentDiagnosticsIssueBadge result={result} />
          {result.status === "blocking" && result.warning_count > 0 && (
            <span className="text-muted-foreground text-xs">
              {t("detail.diagnostics.warningAlongside", { count: result.warning_count })}
            </span>
          )}
        </div>
        <ul className="divide-y">
          {result.diagnostics.map((diagnostic) => {
            const text = agentDiagnosticText(diagnostic, t);
            const target = agentDiagnosticCorrectionTarget(diagnostic, location.pathname);
            return (
              <li key={agentDiagnosticKey(diagnostic)} className="py-4 first:pt-0 last:pb-0">
                <p className="text-sm font-medium">{text.title}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">{text.explanation}</p>
                {(target || (diagnostic.target.node && features.agentMap)) && (
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                    {target && (
                      <LeaveLink
                        to={target}
                        onLeave={onLeave}
                        className="text-primary hover:underline"
                      >
                        {t("detail.diagnostics.fix")}
                      </LeaveLink>
                    )}
                    {/* "Locate" opens the map, served by the opt-in agent-map module. */}
                    {diagnostic.target.node && features.agentMap && (
                      <LeaveLink
                        to={agentDiagnosticLocateTarget(diagnostic, location.pathname)}
                        onLeave={onLeave}
                        className="text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {t("detail.diagnostics.locate")}
                      </LeaveLink>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
