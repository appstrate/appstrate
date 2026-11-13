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
const agentIdentity = () => ({ icon: "lucide:chart-bar", color: "blue" });

/**
 * The column set is a hook — the toolbar's column menu and the table have
 * to name the same columns — so the suite goes through a component that holds
 * it, exactly as a screen does.
 */
function Harness({
  runs,
  oneAgent,
  ...props
}: {
  runs: EnrichedRun[];
  oneAgent?: boolean;
} & Omit<Parameters<typeof RunsTable>[0], "runs" | "columns" | "agentName" | "empty">) {
  const columns = useRunColumns({ agentName, agentIdentity, oneAgent });
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
    expect(html).toContain(`#42 · ${STARTED_AT_LABEL}`); // under the agent, in « Run »
    expect(html).toContain("Rapport trimestriel");
    expect(html).toContain("Alice"); // trigger
    expect(html).toContain('aria-label="eu-proxy"'); // the egress it went through
    expect(html).toContain("4,2\u202fs"); // duration, at the end of « Run »
  });

  it("draws the agent's tile before its name", () => {
    // The tile wears the agent's chosen colour.
    expect(html).toContain("bg-identity-blue/20");
  });

  it("leads to the run, under a name that says which run", () => {
    expect(html).toContain('href="/agents/@acme/reporter/runs/run_1"');
    // Not just the agent: a row has to be identifiable out of context.
    expect(html).toContain('aria-label="Run #42 (Rapport trimestriel)"');
  });

  it("holds which run, how it ended, its timing and its launch — not its outcome", () => {
    // The outcome (error, output, files) lives on the run's own page: a list
    // cell can only truncate it.
    function Probe() {
      return useRunColumns({ agentName, agentIdentity })
        .map((column) => column.id)
        .join(",");
    }
    expect(render(<Probe />)).toBe("status,run,trigger");
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

describe("the status column", () => {
  it("draws no head: the badge says what it is", () => {
    const html = table();
    expect(html).toMatch(/<th[^>]*data-column="status"[^>]*>\s*<span class="sr-only">/);
  });
});

describe("the row's link", () => {
  it("sits on « Run », though the status comes first", () => {
    const html = table();
    expect(html).toMatch(
      /<a aria-label="Run #42 \(Rapport trimestriel\)"[^>]*>\s*<div[^>]*>[\s\S]*?Rapport trimestriel/,
    );
    const status = html.match(/<td[^>]*data-column="status"[^>]*>[\s\S]*?<\/td>/)?.[0] ?? "";
    expect(status).not.toContain('aria-label="Run #42');
  });
});

describe("inside one agent", () => {
  const html = table([makeRun()], { oneAgent: true });

  it("leads « Run » with the number, without repeating the agent", () => {
    expect(html).toContain(">#42<");
    expect(html).not.toContain(">Rapport trimestriel<");
    expect(html).not.toContain("bg-identity-");
  });

  it("still names the row's link after the agent", () => {
    expect(html).toContain('aria-label="Run #42 (Rapport trimestriel)"');
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
