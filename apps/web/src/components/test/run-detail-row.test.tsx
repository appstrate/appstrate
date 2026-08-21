// SPDX-License-Identifier: Apache-2.0

/**
 * The strip pinned under the run-detail page header (#1046).
 *
 * What is under test is what it does NOT show: the facts the page title, the
 * tabs and the Info tab already carry. The panel body is asserted through
 * `RunDetailPanel` directly because the popover keeps its content unmounted
 * until a user opens it, and there is no DOM here to open it with.
 */

import { describe, it, expect } from "bun:test";
import agentsFr from "../../locales/fr/agents.json";
import { RunDetailRow, RunDetailPanel } from "../run-detail-row.tsx";
import { makeRun, render, STARTED_AT } from "./run-fixture.tsx";
import { formatDateField } from "../../lib/markdown.ts";

/** Derived, never hardcoded — `Intl` output is locale- and TZ-dependent. */
const STARTED_AT_LABEL = formatDateField(STARTED_AT);

describe("RunDetailRow", () => {
  const html = render(<RunDetailRow run={makeRun()} />);

  it("drops the columns the page header and tabs already carry", () => {
    expect(html).not.toContain("#42");
    expect(html).not.toContain("Inline");
    expect(html).not.toContain("Alice");
    expect(html).not.toContain(STARTED_AT_LABEL);
    expect(html).not.toContain("2 document(s) en entrée");
    expect(html).not.toContain("1 document(s) en sortie");
  });

  it("renders a static strip, never a link", () => {
    expect(html).not.toContain("<a ");
  });

  it("exposes a keyboard-reachable details trigger with an i18n accessible name", () => {
    expect(html).toContain("<button");
    expect(html).toContain(`aria-label="${agentsFr["run.detailsPanel"]}"`);
    // A <button> is focusable by default — an explicit tabindex="-1" would be
    // the only way to lose that, so assert it is absent.
    expect(html).not.toContain('tabindex="-1"');
  });

  it("keeps the badges that explain a missing Re-run / Cancel button inline", () => {
    const orphaned = render(
      <RunDetailRow run={makeRun({ packageId: null, package_ephemeral: false })} />,
    );
    expect(orphaned).toContain(agentsFr["runs.deletedAgentBadge"]);

    const remote = render(<RunDetailRow run={makeRun({ runOrigin: "remote" })} />);
    expect(remote).toContain(agentsFr["runs.remoteBadge"]);
  });

  it("renders the duration at every breakpoint", () => {
    // Regression (#1046): the duration was gated `hidden sm:inline`, so it
    // vanished at 375px — a primary figure treated as a wide-viewport bonus.
    expect(html).toContain("4.2s");
    expect(html).toMatch(/class="[^"]*font-mono[^"]*"[^>]*>4\.2s/);
    expect(html).not.toMatch(/class="[^"]*hidden[^"]*"[^>]*>4\.2s/);
  });
});

describe("RunDetailPanel (the panel body)", () => {
  const html = render(<RunDetailPanel run={makeRun()} />);

  it("carries the INLINE badge, which no other surface renders", () => {
    expect(html).toContain(agentsFr["runs.inlineBadge"]);
  });

  it("groups the document counters into a single line", () => {
    // The Documents tab badge shows a total; only the in/out split lives here.
    expect(html).toContain("2 en entrée · 1 en sortie");
  });

  it("leaves the facts the Info tab owns to the Info tab", () => {
    // Trigger, start date and proxy are rendered by `run-info-tab.tsx`
    // (`run.infoTrigger`, `run.infoStartedAt`, `run.infoProxy`). Re-listing
    // them here is the duplication #1046 removed.
    //
    // Not a vacuous assertion: `makeRun()` carries a trigger, a proxy label and
    // a start date, and the run-table suite proves the same fixture renders all
    // three — so a re-added panel row fails here.
    expect(html).not.toContain(agentsFr["run.infoTrigger"]);
    expect(html).not.toContain("Alice");
    expect(html).not.toContain(agentsFr["run.infoStartedAt"]);
    expect(html).not.toContain(STARTED_AT_LABEL);
    expect(html).not.toContain(agentsFr["run.infoProxy"]);
    expect(html).not.toContain("eu-proxy");
  });

  it("carries the token total, on a focusable trigger for the bucket breakdown", () => {
    expect(html).toContain(agentsFr["run.usageTokensTotal"]);
    // 1000 + 200 + 30 + 4, grouped by `toLocaleString`.
    expect(html).toContain((1234).toLocaleString());
    expect(html).toContain('tabindex="0"');
  });

  it("distinguishes a never-measured usage from a measured zero", () => {
    // `runs.token_usage` is NULL on a run that failed before reaching the model.
    // `totalTokens({})` turned that into a confident `0` under a four-zero
    // tooltip — "consumed nothing" where the truth is "never measured".
    const never = render(<RunDetailPanel run={makeRun({ token_usage: null })} />);
    expect(never).toContain(agentsFr["run.usageTokensTotal"]);
    expect(never).toContain("—");
    expect(never).not.toMatch(/>0</);
    // No tooltip trigger either: there are no buckets to break down.
    expect(never).not.toContain('tabindex="0"');

    const measured = render(
      <RunDetailPanel
        run={makeRun({
          token_usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        })}
      />,
    );
    expect(measured).toMatch(/>0</);
    expect(measured).not.toContain("—");
    expect(measured).toContain('tabindex="0"');
  });

  it("omits the rows whose data the run does not have", () => {
    const bare = render(
      <RunDetailPanel
        run={makeRun({
          package_ephemeral: false,
          document_counts: { input: 0, output: 0 },
        })}
      />,
    );
    expect(bare).not.toContain(agentsFr["runs.inlineBadge"]);
    expect(bare).not.toContain(agentsFr["run.tabDocuments"]);
    // The token total is structural — a run that consumed nothing still shows 0.
    expect(bare).toContain(agentsFr["run.usageTokensTotal"]);
  });
});
