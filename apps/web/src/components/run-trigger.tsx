// SPDX-License-Identifier: Apache-2.0

import { User, Calendar, Key, UserCircle } from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";

/** Displays the run trigger (schedule, end-user, API key, or user) as icon + label. */
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
