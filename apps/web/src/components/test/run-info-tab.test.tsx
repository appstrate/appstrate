// SPDX-License-Identifier: Apache-2.0

/**
 * `TurnsTable` normalization tests (#1046), driven through its only public
 * surface `RunInfoTab` — the table is a private child, and exporting it just to
 * test it would widen the module boundary for the test's convenience.
 *
 * Same no-DOM harness as `run-row.test.tsx`.
 */

import type { ReactElement } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import agentsFr from "../../locales/fr/agents.json";
import i18n, { i18nReady } from "../../i18n.ts";
import type { RunTurnRow } from "../log-utils.ts";
import { formatWindowPercent } from "../run-context.ts";
import { RunInfoTab } from "../run-info-tab.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const WINDOW = 200_000;

function turn(index: number, contextTokens: number): RunTurnRow {
  return {
    index,
    contextTokens,
    inputTokens: contextTokens,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 1_500,
  };
}

/** Peak 100k = half the window, so window- and peak-relative bars differ. */
const TURNS = [turn(0, 50_000), turn(1, 100_000)];

function makeRun(overrides: Partial<EnrichedRun> = {}): EnrichedRun {
  return {
    id: "run_1",
    runNumber: 7,
    status: "success",
    packageId: "@acme/reporter",
    started_at: "2026-07-01T10:00:00.000Z",
    duration: 4200,
    version_ref: "1.0.0",
    package_ephemeral: false,
    runOrigin: "platform",
    context_window: WINDOW,
    compaction_threshold: 136_000,
    document_counts: { input: 0, output: 0 },
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

describe("TurnsTable with a known context window", () => {
  const html = render(<RunInfoTab run={makeRun()} turns={TURNS} />);

  it("renders the `%` column with each turn's share of the WINDOW", () => {
    expect(html).toContain(agentsFr["run.turnContextShare"]);
    expect(html).toContain(formatWindowPercent(0.25, i18n.language));
    expect(html).toContain(formatWindowPercent(0.5, i18n.language));
  });

  it("normalizes the bars on the window, so the widest is NOT automatically full", () => {
    expect(html).toContain("width:25%");
    expect(html).toContain("width:50%");
    expect(html).not.toContain("width:100%");
  });
});

describe("TurnsTable without a context window", () => {
  const html = render(<RunInfoTab run={makeRun({ context_window: null })} turns={TURNS} />);

  it("omits the `%` column rather than inventing a 200k denominator", () => {
    expect(html).not.toContain(agentsFr["run.turnContextShare"]);
    expect(html).not.toContain(formatWindowPercent(0.25, i18n.language));
  });

  it("falls back to the peak-relative bar so the breakdown stays readable", () => {
    expect(html).toContain("width:50%");
    expect(html).toContain("width:100%");
  });

  it("still lists the absolute token counts the header gauge had to drop", () => {
    expect(html).toContain((100_000).toLocaleString());
  });
});
