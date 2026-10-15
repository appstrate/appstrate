// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Shield } from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { RunStatusBadge } from "./status-badge";
import { DocumentCounts, RunProvenanceBadges } from "./run-cells";
import { RunDuration } from "./run-duration";
import { RunTrigger } from "./run-trigger";
import { formatDateField } from "../lib/format-date";
import { runDetailPath } from "../lib/package-paths";
import { runErrorText, runErrorTone } from "../lib/run-error";

/** A second, genuinely card-shaped reading of the rows already fetched by RunList. */
export function RunCard({ run, agentName }: { run: EnrichedRun; agentName: string }) {
  const { t } = useTranslation("agents");
  const href = run.packageId ? runDetailPath(run.packageId, run.id) : undefined;

  const content = (
    <>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-medium">
              {/* The card's link, stretched over the whole card. */}
              {href ? (
                <Link
                  to={href}
                  state={{ runNumber: run.runNumber }}
                  className="after:absolute after:inset-0"
                >
                  {agentName}
                </Link>
              ) : (
                agentName
              )}
            </h2>
            {run.runNumber != null && (
              <span className="text-muted-foreground shrink-0 font-mono text-xs">
                #{run.runNumber}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <RunProvenanceBadges run={run} />
          </div>
        </div>
        <RunStatusBadge status={run.status} unread={run.unread} />
      </div>

      {run.error && (
        <p
          className={cn(runErrorTone(run), "mt-3 line-clamp-2 font-mono text-xs")}
          title={runErrorText(run, t)}
        >
          {runErrorText(run, t)}
        </p>
      )}

      <div className="text-muted-foreground mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-4 text-xs">
        <RunTrigger run={run} />
        {run.proxy_label && <Shield size={12} aria-label={run.proxy_label} />}
        <DocumentCounts run={run} />
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

  return (
    <div
      className={cn(
        "border-border bg-card relative flex h-full min-h-36 flex-col rounded-lg border p-4 transition-colors",
        href && "hover:bg-accent/50",
      )}
    >
      {content}
    </div>
  );
}
