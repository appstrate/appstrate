// SPDX-License-Identifier: Apache-2.0

/**
 * The runs column set over the shared table.
 *
 * What is under test is the set itself — which facts get a column, what a
 * column shows when the run has nothing to put in it, and what a surface
 * subtracts when it already knows the answer.
 */

import { describe, it, expect } from "bun:test";
import agentsFr from "../../locales/fr/agents.json";
import { RunsTable } from "../runs-table.tsx";
import { makeRun, render, STARTED_AT } from "./run-fixture.tsx";
import { formatDateField } from "../../lib/markdown.ts";

const STARTED_AT_LABEL = formatDateField(STARTED_AT);
const agentName = () => "Rapport trimestriel";

function table(runs = [makeRun()], props = {}) {
  return render(<RunsTable runs={runs} agentName={agentName} {...props} />);
}

describe("the runs column set", () => {
  const html = table();

  it("heads every column of the set", () => {
    // Read off the bundle rather than retyped: a column added without a head,
    // or a head left untranslated, fails here.
    const heads = Object.entries(agentsFr)
      .filter(([key]) => key.startsWith("runs.column."))
      .map(([, label]) => label);
    expect(heads).toHaveLength(8);
    for (const head of heads) expect(html).toContain(head);
  });

  it("renders the run's facts in their columns", () => {
    expect(html).toContain("#42");
    expect(html).toContain("Rapport trimestriel");
    expect(html).toContain("Alice"); // trigger
    expect(html).toContain("4.2s"); // duration
    expect(html).toContain(STARTED_AT_LABEL);
  });

  it("leads to the run, under a name that says which run", () => {
    expect(html).toContain('href="/agents/@acme/reporter/runs/run_1"');
    // Not "#42": the link sits in the agent column, and a row has to be
    // identifiable out of context.
    expect(html).toContain('aria-label="Run #42 — Rapport trimestriel"');
  });
});

describe("the result column", () => {
  it("shows what broke, which the list could not say before", () => {
    const message = "Connexion refusée : le code 2FA a expiré.";
    const html = table([makeRun({ status: "failed", error: message })]);
    expect(html).toContain(message);
    // Truncated in place, so the full text stays reachable on hover.
    expect(html).toContain(`title="${message}"`);
  });

  it("says nothing rather than inventing a result on a run that worked", () => {
    expect(table()).toContain("—");
  });
});

describe("what a surface subtracts", () => {
  it("drops the agent column inside an agent, head and cells together", () => {
    const html = table([makeRun()], { hideAgentName: true });
    expect(html).not.toContain(agentsFr["runs.column.agent"]);
    expect(html).not.toContain(">Rapport trimestriel<");
    // The row's accessible NAME keeps it, though: a link has to say which run
    // it leads to even when the column that showed it is gone.
    expect(html).toContain('aria-label="Run #42 — Rapport trimestriel"');
    // The row still leads somewhere: the link moves to the next surviving column.
    expect(html).toContain('href="/agents/@acme/reporter/runs/run_1"');
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
