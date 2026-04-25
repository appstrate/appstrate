// SPDX-License-Identifier: Apache-2.0

import { User, Calendar, Key, UserCircle, Terminal, Workflow, Globe } from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";

function RunnerIcon({ kind }: { kind: string | null | undefined }) {
  if (kind === "cli") return <Terminal size={12} className="shrink-0" />;
  if (kind === "github-action") return <Workflow size={12} className="shrink-0" />;
  return <Globe size={12} className="shrink-0" />;
}

/**
 * Displays the run trigger as icon + label. Priority order:
 *
 *   1. Schedule (cron-driven)
 *   2. End-user impersonation
 *   3. API key (e.g. CI integrations without runner metadata)
 *   4. Runner label (CLI hostname, GitHub Action workflow, …)
 *   5. Dashboard user
 */
export function RunTrigger({ run }: { run: EnrichedRun }) {
  if (run.scheduleId) {
    return (
      <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs">
        <Calendar size={12} className="shrink-0" />
        <span className="truncate">{run.scheduleName || run.scheduleId}</span>
      </span>
    );
  }
  if (run.endUserName) {
    return (
      <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs">
        <UserCircle size={12} className="shrink-0" />
        <span className="truncate">{run.endUserName}</span>
      </span>
    );
  }
  if (run.apiKeyName) {
    return (
      <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs">
        <Key size={12} className="shrink-0" />
        <span className="truncate">{run.apiKeyName}</span>
      </span>
    );
  }
  if (run.runnerName) {
    return (
      <span
        className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs"
        title={run.runnerKind ? `${run.runnerName} (${run.runnerKind})` : run.runnerName}
      >
        <RunnerIcon kind={run.runnerKind} />
        <span className="truncate">{run.runnerName}</span>
      </span>
    );
  }
  if (run.dashboardUserName) {
    return (
      <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs">
        <User size={12} className="shrink-0" />
        <span className="truncate">{run.dashboardUserName}</span>
      </span>
    );
  }
  return null;
}
