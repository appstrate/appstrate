// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FileInput, FileOutput, Shield } from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { Badge, MetaBadge } from "./status-badge";
import { RunDuration } from "./run-duration";
import { RunTrigger } from "./run-trigger";
import { formatDateField } from "../lib/markdown";

/** A second, genuinely card-shaped reading of the rows already fetched by RunList. */
export function RunCard({ run, agentName }: { run: EnrichedRun; agentName: string }) {
  const { t } = useTranslation("agents");
  const href = run.packageId ? `/agents/${run.packageId}/runs/${run.id}` : undefined;

  const content = (
    <>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-medium">{agentName}</h2>
            {run.runNumber != null && (
              <span className="text-muted-foreground shrink-0 font-mono text-xs">
                #{run.runNumber}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {run.package_ephemeral === true && <MetaBadge label={t("runs.inlineBadge")} />}
            {run.packageId == null && run.package_ephemeral !== true && (
              <MetaBadge
                label={t("runs.deletedAgentBadge")}
                title={t("runs.deletedAgentTitle")}
                italic
              />
            )}
            {run.runOrigin === "remote" && (
              <MetaBadge label={t("runs.remoteBadge")} title={t("runs.remoteBadgeTitle")} />
            )}
          </div>
        </div>
        <Badge status={run.status} unread={run.unread} />
      </div>

      {run.error && (
        <p className="text-destructive mt-3 line-clamp-2 font-mono text-xs" title={run.error}>
          {run.error}
        </p>
      )}

      <div className="text-muted-foreground mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-4 text-xs">
        <RunTrigger run={run} />
        {run.proxy_label && <Shield size={12} aria-label={run.proxy_label} />}
        {run.document_counts.input > 0 && (
          <span
            className="flex items-center gap-1"
            title={t("run.inputDocuments", { count: run.document_counts.input })}
          >
            <FileInput size={12} />
            {run.document_counts.input}
          </span>
        )}
        {run.document_counts.output > 0 && (
          <span
            className="flex items-center gap-1"
            title={t("run.outputDocuments", { count: run.document_counts.output })}
          >
            <FileOutput size={12} />
            {run.document_counts.output}
          </span>
        )}
        <span className="ml-auto">
          <RunDuration status={run.status} startedAt={run.started_at} duration={run.duration} />
        </span>
      </div>
      {run.started_at && (
        <p className="text-muted-foreground mt-2 text-right text-xs">
          {formatDateField(run.started_at)}
        </p>
      )}
    </>
  );

  const className = cn(
    "border-border bg-card flex h-full min-h-36 flex-col rounded-lg border p-4 transition-colors",
    href && "hover:bg-accent/50",
  );

  return href ? (
    <Link className={className} to={href} state={{ runNumber: run.runNumber }}>
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}
