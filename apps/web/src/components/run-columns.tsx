// SPDX-License-Identifier: Apache-2.0

/**
 * The runs column set over {@link DataTable}: how it ended first, then which run
 * (its agent, number, start and duration, on two lines — the same block as the
 * dashboard's rows) and who launched it. The status leads, in a column of its
 * own: finding what failed or still runs is reading down the list, and that
 * needs the badges lined up at the edge the eye starts from.
 *
 * The set is ONE array of column literals. Widths, breakpoint behaviour,
 * alignment and content sit together per column, so adding one is one edit
 * rather than the same key typed into five parallel maps.
 *
 * Every track is content-INDEPENDENT (px or fr), and that is a constraint, not
 * a style: each row is its own grid container, so an `auto` track would be
 * measured per row and the columns would stop lining up — the one thing the
 * table exists to do.
 */

import { useTranslation } from "react-i18next";
import { Shield } from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";
import type { RunAgentIdentity } from "../hooks/use-run-agent-identity";
import type { DataColumn } from "./data-table";
import { RunIdentity } from "./run-identity";
import { RunStatusBadge } from "./status-badge";
import { RunTrigger } from "./run-trigger";

/**
 * The column set, as a value the caller holds.
 *
 * A hook rather than a constant because every header is translated, and a value
 * the CALLER holds because the toolbar's column menu and the table have to be
 * talking about the same columns — the menu names them, the table draws
 * whatever is left of them.
 */
export function useRunColumns({
  agentName,
  agentIdentity,
  oneAgent = false,
}: {
  /** What to call the agent a run executed — see `use-run-agent-name.ts`. */
  agentName: (run: EnrichedRun) => string;
  /** Its tile, drawn before the name — see `use-run-agent-identity.ts`. */
  agentIdentity: (run: EnrichedRun) => RunAgentIdentity;
  /**
   * Every run is one agent's (its tab, a schedule's history): the agent would
   * repeat the page title on every row, so the « Run » column leads with the
   * number instead.
   */
  oneAgent?: boolean;
}): DataColumn<EnrichedRun>[] {
  const { t } = useTranslation(["agents"]);

  return [
    {
      id: "status",
      header: t("runs.column.status"),
      // The badge says it is a status: a head would only take room.
      hideHeader: true,
      // The pill alone plus the cell's padding (12px each side): the unread dot
      // is absolute and overflows into that padding. 99px fits the longest
      // label, « en attente »; the compact icon is 16px.
      width: 124,
      // In a table under 32rem the compact badge is its icon alone: the column follows.
      narrowWidth: 40,
      cell: (run) => <RunStatusBadge status={run.status} compact unread={run.unread} />,
    },
    {
      id: "run",
      header: t("runs.column.run"),
      // The row's name, though the status comes first: it carries the row's
      // link, stays in place when the table scrolls, and cannot be hidden.
      identity: true,
      width: 180,
      elastic: true,
      cell: (run) => (
        <RunIdentity
          run={run}
          agent={oneAgent ? undefined : { name: agentName(run), identity: agentIdentity(run) }}
        />
      ),
    },
    {
      id: "trigger",
      header: t("runs.column.trigger"),
      width: 80,
      elastic: true,
      cell: (run) => (
        <>
          <RunTrigger run={run} />
          {/* Which egress the run went through. It sits beside the trigger
              because both answer "how did this run reach the outside" — and it
              is here at all because dropping it was an oversight, not a call. */}
          {run.proxy_label && (
            <Shield
              size={12}
              className="text-muted-foreground relative z-10 shrink-0"
              aria-label={run.proxy_label}
            />
          )}
        </>
      ),
    },
  ];
}
