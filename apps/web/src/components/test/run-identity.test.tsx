// SPDX-License-Identifier: Apache-2.0

/**
 * Which run this is, on two lines — the block the runs table's « Run » column
 * and `RunRow` both draw.
 */

import { describe, it, expect } from "bun:test";
import agentsFr from "../../locales/fr/agents.json";
import { RunIdentity } from "../run-identity.tsx";
import { RunRow } from "../run-row.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { makeRun, STARTED_AT } from "../../test/run-fixture.ts";
import { formatDateField } from "../../lib/format-date.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const AGENT = {
  name: "Rapport trimestriel",
  identity: { icon: "lucide:chart-bar", color: "blue" },
};
const START = formatDateField(STARTED_AT);

describe("RunIdentity with its agent", () => {
  const html = render(<RunIdentity run={makeRun()} agent={AGENT} />);

  it("leads with the agent's tile and name", () => {
    expect(html).toContain(AGENT.name);
    expect(html).toContain("bg-identity-blue/20");
  });

  it("puts the number, the start and the duration under the name", () => {
    expect(html).toContain(`#42 · ${START}`);
    expect(html).toContain("4,2\u202fs");
    // The separator is the duration's own, drawn only when there is one.
    expect(html).toContain("before:content-['_·_']");
  });

  it("leaves the separator out with the duration when there is none yet", () => {
    const pending = render(
      <RunIdentity
        run={makeRun({ status: "pending", started_at: null, duration: null })}
        agent={AGENT}
      />,
    );
    expect(pending).not.toContain("before:content-");
  });
});

describe("RunIdentity inside one agent", () => {
  const html = render(<RunIdentity run={makeRun()} />);

  it("leads with the number, without repeating the agent", () => {
    expect(html).toContain(">#42<");
    expect(html).not.toContain(AGENT.name);
    expect(html).not.toContain("bg-identity-");
  });

  it("puts the start under it", () => {
    expect(html).toContain(START);
  });
});

describe("RunIdentity, whatever the context", () => {
  it("says the start is pending before the run has one", () => {
    const html = render(<RunIdentity run={makeRun({ started_at: null })} agent={AGENT} />);
    expect(html).toContain(`#42 · ${agentsFr["dashboard.runPending"]}`);
  });

  it("explains a missing link on the first line", () => {
    const html = render(
      <RunIdentity run={makeRun({ packageId: null, package_ephemeral: false })} agent={AGENT} />,
    );
    expect(html).toContain(agentsFr["runs.deletedAgentBadge"]);
  });
});

describe("RunRow", () => {
  it("draws the same block, and leads to the run", () => {
    const html = render(<RunRow run={makeRun()} agentName={AGENT.name} agent={AGENT.identity} />);
    expect(html).toContain(`#42 · ${START}`);
    expect(html).toContain('href="/agents/@acme/reporter/runs/run_1"');
  });
});
