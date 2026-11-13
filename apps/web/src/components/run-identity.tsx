// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import type { RunAgentIdentity } from "../hooks/use-run-agent-identity";
import { formatDateField } from "../lib/format-date";
import { PackageIcon } from "./package-icon";
import { RunProvenanceBadges } from "./run-provenance-badges";
import { RunDuration } from "./run-duration";

/**
 * Which run this is, on two lines, wherever a run is listed: the runs table's
 * « Run » column and `RunRow` (dashboard, chat panel) draw this same block.
 *
 * With its `agent`: the agent's tile and name, then `#42 · <start> · <duration>`
 * under them. Without (inside one agent, whose name is already the page's):
 * `#42`, then `<start> · <duration>`. Either way the badges explaining an action
 * the run lacks sit on the first line.
 */
export function RunIdentity({
  run,
  agent,
}: {
  run: EnrichedRun;
  agent?: {
    /** What to call it — see `use-run-agent-name.ts`. */
    name: string;
    /** Its tile — see `use-run-agent-identity.ts`. Absent draws the default tile. */
    identity?: RunAgentIdentity;
  };
}) {
  const { t } = useTranslation("agents");
  const number = `#${run.runNumber ?? "?"}`;
  const start = run.started_at ? formatDateField(run.started_at) : t("dashboard.runPending");

  return (
    <>
      {agent && (
        <PackageIcon
          type="agent"
          id={run.packageId ?? agent.name}
          name={agent.name}
          icon={agent.identity?.icon}
          color={agent.identity?.color}
          className="size-8 rounded-lg"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{agent ? agent.name : number}</span>
          <RunProvenanceBadges run={run} />
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs">
          {agent ? `${number} · ${start}` : start}
          {/* Live while the run goes, absent until it has a figure: the
              separator belongs to the duration, so it never dangles. */}
          <RunDuration
            status={run.status}
            startedAt={run.started_at}
            duration={run.duration}
            className="before:content-['_·_']"
          />
        </p>
      </div>
    </>
  );
}
