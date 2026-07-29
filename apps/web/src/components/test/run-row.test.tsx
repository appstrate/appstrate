// SPDX-License-Identifier: Apache-2.0

/**
 * `RunRow` variant tests (#1046).
 *
 * The web test runner has no DOM, so the component is rendered with
 * `renderToStaticMarkup` and asserted on its HTML. That is enough for what is
 * under test here — which columns a variant emits — and needs no new
 * dependency: `react-dom`, `react-router-dom` and `i18next` are already SPA
 * deps. The details panel is asserted through `RunRowDetails` directly because
 * the popover keeps its content unmounted until a user opens it.
 */

import type { ReactElement } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import agentsFr from "../../locales/fr/agents.json";
import { formatDateField } from "../../lib/markdown.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import { RunRow, RunRowDetails } from "../run-row.tsx";

// The SPA's own i18n instance, not a hand-rolled one: `formatDateField` reads
// `i18n.language` off this singleton, so a private instance would render dates
// under whatever locale the runner happened to default to while the assertions
// used another. Pin the language rather than trusting the ambient default.
await i18nReady;
await i18n.changeLanguage("fr");

const STARTED_AT = "2026-07-01T10:00:00.000Z";
/** Derived, never hardcoded — `Intl` output is locale- and TZ-dependent. */
const STARTED_AT_LABEL = formatDateField(STARTED_AT);

/** A terminal run carrying every field the row can display. */
function makeRun(overrides: Partial<EnrichedRun> = {}): EnrichedRun {
  return {
    id: "run_1",
    runNumber: 42,
    status: "success",
    packageId: "@acme/reporter",
    started_at: STARTED_AT,
    duration: 4200,
    document_counts: { input: 2, output: 1 },
    proxy_label: "eu-proxy",
    user_name: "Alice",
    package_ephemeral: true,
    token_usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 4,
    },
    ...overrides,
  } as unknown as EnrichedRun;
}

function render(node: ReactElement): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>{node}</MemoryRouter>
    </I18nextProvider>,
  );
}

describe("RunRow variant=list (default)", () => {
  const html = render(<RunRow run={makeRun()} />);

  it("renders the run number, the INLINE badge, the trigger and the start date", () => {
    expect(html).toContain("#42");
    expect(html).toContain("Inline");
    expect(html).toContain("Alice");
    expect(html).toContain(STARTED_AT_LABEL);
  });

  it("renders the input and output document counters", () => {
    expect(html).toContain("2 document(s) en entrée");
    expect(html).toContain("1 document(s) en sortie");
  });

  it("stays a navigable link and grows no details trigger", () => {
    expect(html).toContain('href="/agents/@acme/reporter/runs/run_1"');
    expect(html).not.toContain(agentsFr["run.detailsPanel"]);
  });
});

describe("RunRow variant=detail", () => {
  const html = render(<RunRow run={makeRun()} variant="detail" />);

  it("drops the columns the page header and tabs already carry", () => {
    expect(html).not.toContain("#42");
    expect(html).not.toContain("Inline");
    expect(html).not.toContain("Alice");
    expect(html).not.toContain(STARTED_AT_LABEL);
    expect(html).not.toContain("2 document(s) en entrée");
    expect(html).not.toContain("1 document(s) en sortie");
  });

  it("renders a static row instead of a link", () => {
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
      <RunRow run={makeRun({ packageId: null, package_ephemeral: false })} variant="detail" />,
    );
    expect(orphaned).toContain(agentsFr["runs.deletedAgentBadge"]);

    const remote = render(<RunRow run={makeRun({ runOrigin: "remote" })} variant="detail" />);
    expect(remote).toContain(agentsFr["runs.remoteBadge"]);
  });
});

describe("RunRow duration", () => {
  // Regression (#1046): the duration was gated `hidden sm:inline`, so it
  // vanished at 375px — a primary figure treated as a wide-viewport bonus.
  for (const variant of ["list", "detail"] as const) {
    it(`renders at every breakpoint in variant=${variant}`, () => {
      const html = render(<RunRow run={makeRun()} variant={variant} />);
      expect(html).toContain("4.2s");
      expect(html).toMatch(/class="[^"]*font-mono[^"]*"[^>]*>4\.2s/);
      expect(html).not.toMatch(/class="[^"]*hidden[^"]*"[^>]*>4\.2s/);
    });
  }
});

describe("RunRowDetails (the panel body)", () => {
  const html = render(<RunRowDetails run={makeRun()} />);

  it("carries the INLINE badge, which no other surface renders", () => {
    expect(html).toContain(agentsFr["runs.inlineBadge"]);
  });

  it("groups the document counters into a single line", () => {
    // The Documents tab badge shows a total; only the in/out split lives here.
    expect(html).toContain("2 en entrée · 1 en sortie");
  });

  it("leaves the facts the Info tab owns to the Info tab", () => {
    // Trigger, start date and proxy are rendered by `run-info-tab.tsx`
    // (`run.infoTrigger` l.149, `run.infoStartedAt` l.173, `run.infoProxy`
    // l.179). Re-listing them here is the duplication #1046 removes.
    //
    // Not a vacuous assertion: `makeRun()` carries a trigger, a proxy label and
    // a start date, and the `variant=list` suite above proves the same fixture
    // renders all three — so a re-added panel row fails here.
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

  it("omits the rows whose data the run does not have", () => {
    const bare = render(
      <RunRowDetails
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
