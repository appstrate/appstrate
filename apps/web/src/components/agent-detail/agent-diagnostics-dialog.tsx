// SPDX-License-Identifier: Apache-2.0

/** One diagnostic list for every Agent projection. */

import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CircleX, TriangleAlert } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { cn } from "@appstrate/ui/cn";
import { Modal } from "../modal";
import type { AgentDiagnostics } from "../../hooks/use-agent-diagnostics";
import {
  agentDiagnosticCorrectionTarget,
  agentDiagnosticKey,
  agentDiagnosticLocateTarget,
} from "../../lib/agent-diagnostics";

function agentDiagnosticsLabel(
  result: AgentDiagnostics,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return result.status === "blocking"
    ? t("detail.diagnostics.blockingTitle", { count: result.blocking_count })
    : t("detail.diagnostics.warningTitle", { count: result.warning_count });
}

export function AgentDiagnosticsIssueBadge({
  result,
  className,
}: {
  result: AgentDiagnostics;
  className?: string;
}) {
  const { t } = useTranslation("agents");
  if (result.status === "healthy") return null;
  const Icon = result.status === "blocking" ? CircleX : TriangleAlert;
  return (
    <Badge
      variant={result.status === "blocking" ? "failed" : "warning"}
      className={cn("gap-1", className)}
    >
      <Icon className="size-3" aria-hidden />
      {agentDiagnosticsLabel(result, t)}
    </Badge>
  );
}

export function AgentDiagnosticsDialog({
  result,
  open,
  onClose,
}: {
  result: AgentDiagnostics | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("agents");
  const location = useLocation();
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
          {result.diagnostics.map((diagnostic) => (
            <li key={agentDiagnosticKey(diagnostic)} className="py-4 first:pt-0 last:pb-0">
              <p className="text-sm font-medium">{diagnostic.title}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">{diagnostic.explanation}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                <Link
                  to={agentDiagnosticCorrectionTarget(
                    diagnostic,
                    location.pathname,
                    location.search,
                  )}
                  onClick={onClose}
                  className="text-primary hover:underline"
                >
                  {t("detail.diagnostics.fix")}
                </Link>
                {diagnostic.target.node && (
                  <Link
                    to={agentDiagnosticLocateTarget(diagnostic, location.pathname, location.search)}
                    onClick={onClose}
                    className="text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {t("detail.diagnostics.locate")}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
