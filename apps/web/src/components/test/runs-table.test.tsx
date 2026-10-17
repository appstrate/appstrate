// SPDX-License-Identifier: Apache-2.0

/**
 * The runs column set over the shared table.
 *
 * What is under test is the set itself — which facts get a column, what a
 * column shows when the run has nothing to put in it, and what a surface
 * subtracts when it already knows the answer.
 */

import { describe, it, expect } from "bun:test";
import type { EnrichedRun } from "@appstrate/shared-types";
import agentsFr from "../../locales/fr/agents.json";
import { RunsTable } from "../runs-table.tsx";
import { useRunColumns } from "../run-columns.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { makeRun, STARTED_AT } from "../../test/run-fixture.ts";
import { formatDateField } from "../../lib/format-date.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const STARTED_AT_LABEL = formatDateField(STARTED_AT);
const agentName = () => "Rapport trimestriel";
const agentIdentity = () => ({ icon: "lucide:chart-bar", color: "#2563eb" });

/**
 * The column set is a hook — the toolbar's column menu and the table have
 * to name the same columns — so the suite goes through a component that holds
 * it, exactly as a screen does.
 */
function Harness({
  runs,
  hideAgentName,
  ...props
}: {
  runs: EnrichedRun[];
  hideAgentName?: boolean;
} & Omit<Parameters<typeof RunsTable>[0], "runs" | "columns" | "agentName" | "empty">) {
  const columns = useRunColumns({ agentName, agentIdentity, hideAgentName });
  return <RunsTable runs={runs} columns={columns} agentName={agentName} empty={null} {...props} />;
}

function table(runs = [makeRun()], props = {}) {
  return render(<Harness runs={runs} {...props} />);
}

describe("the runs column set", () => {
  const html = table();

  it("heads every column of the set", () => {
    // Read off the bundle rather than retyped: a column added without a head,
    // or a head left untranslated, fails here.
    const heads = Object.entries(agentsFr)
      .filter(([key]) => key.startsWith("runs.column."))
      .map(([, label]) => label);
    for (const head of heads) expect(html).toContain(head);
  });

  it("renders the run's facts in their columns", () => {
    expect(html).toContain("#42");
    expect(html).toContain("Rapport trimestriel");
    expect(html).toContain("Alice"); // trigger
    expect(html).toContain('aria-label="eu-proxy"'); // the egress it went through
    expect(html).toContain("4,2\u202fs"); // duration
    expect(html).toContain(STARTED_AT_LABEL);
  });

  it("draws the agent's tile before its name", () => {
    // `#2563eb` is the agent's custom colour: the tile is tinted with it.
    expect(html).toContain("#2563eb1f");
  });

  it("leads to the run, under a name that says which run", () => {
    expect(html).toContain('href="/agents/@acme/reporter/runs/run_1"');
    // Not "#42": the link sits in the agent column, and a row has to be
    // identifiable out of context.
    expect(html).toContain('aria-label="Run #42 (Rapport trimestriel)"');
  });

  it("holds the run's identity and timing, not its outcome", () => {
    // The outcome (error, output, files) lives on the run's own page: a list
    // cell can only truncate it.
    function Probe() {
      return useRunColumns({ agentName, agentIdentity })
        .map((column) => column.id)
        .join(",");
    }
    expect(render(<Probe />)).toBe("num,agent,status,trigger,duration,date");
  });
});

describe("the trigger column", () => {
  it("says the kind of launch when nothing names who made it", () => {
    const html = table([makeRun({ user_name: null, apiKeyId: "key_1" })]);
    expect(html).toContain("API");
  });

  it("is a dash, not a blank, when nothing is recorded", () => {
    const html = table([makeRun({ user_name: null, proxy_label: null })]);
    expect(html).not.toContain("Alice");
    expect(html).toContain("text-muted-foreground/50");
  });
});

describe("what a surface subtracts", () => {
  it("drops the agent column inside an agent, head and cells together", () => {
    const html = table([makeRun()], { hideAgentName: true });
    expect(html).not.toContain(agentsFr["schedule.agent"]);
    expect(html).not.toContain(">Rapport trimestriel<");
    expect(html).not.toContain("#2563eb1f");
    // The row's accessible NAME keeps it, though: a link has to say which run
    // it leads to even when the column that showed it is gone.
    expect(html).toContain('aria-label="Run #42 (Rapport trimestriel)"');
    // The row still leads somewhere: the link moves to the next surviving column.
    expect(html).toContain('href="/agents/@acme/reporter/runs/run_1"');
  });

  it("keeps the badges that explain a missing Cancel or Re-run", () => {
    const html = table([makeRun({ package_ephemeral: false, runOrigin: "remote" })], {
      hideAgentName: true,
    });
    expect(html).toContain(agentsFr["runs.remoteBadge"]);
  });
});

describe("a run whose agent was deleted", () => {
  const html = table([makeRun({ packageId: null, package_ephemeral: false })]);

  it("stays static — its agent page would 404", () => {
    expect(html).not.toContain("<a ");
  });

  it("says why, where the missing link is", () => {
    expect(html).toContain(agentsFr["runs.deletedAgentBadge"]);
  });
});
