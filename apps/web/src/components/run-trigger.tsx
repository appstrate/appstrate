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
        <span className="truncate">{run.schedule_name || run.scheduleId}</span>
      </span>
    );
  }
  if (run.end_user_name) {
    return (
      <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs">
        <UserCircle size={12} className="shrink-0" />
        <span className="truncate">{run.end_user_name}</span>
      </span>
    );
  }
  if (run.api_key_name) {
    return (
      <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs">
        <Key size={12} className="shrink-0" />
        <span className="truncate">{run.api_key_name}</span>
      </span>
    );
  }
  if (run.runner_name) {
    const tooltip = run.runner_kind ? `${run.runner_name} (${run.runner_kind})` : run.runner_name;
    return (
      <span
        className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs"
        title={run.user_name ? `${tooltip} · ${run.user_name}` : tooltip}
      >
        <RunnerIcon kind={run.runner_kind} />
        <span className="truncate">{run.runner_name}</span>
        {run.user_name ? (
          <>
            <span className="shrink-0">·</span>
            <User size={12} className="shrink-0" />
            <span className="truncate">{run.user_name}</span>
          </>
        ) : null}
      </span>
    );
  }
  if (run.user_name) {
    return (
      <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs">
        <User size={12} className="shrink-0" />
        <span className="truncate">{run.user_name}</span>
      </span>
    );
  }
  return null;
}
