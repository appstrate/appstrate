// SPDX-License-Identifier: Apache-2.0

/**
 * `TurnsTable` normalization tests (#1046), driven through its only public
 * surface `RunInfoTab` — the table is a private child, and exporting it just to
 * test it would widen the module boundary for the test's convenience.
 *
 * Same no-DOM harness as `run-detail-row.test.tsx`.
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

/**
 * A turn as the runner emits it: it states the window it ran against, which is
 * now the table's only source for the denominator.
 */
function turn(index: number, contextTokens: number): RunTurnRow {
  return { ...windowlessTurn(index, contextTokens), contextWindow: WINDOW };
}

/** A turn with the window key ABSENT — a run predating it, or an unsizable model. */
function windowlessTurn(index: number, contextTokens: number): RunTurnRow {
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
/** The same series from a runner that stated no window. */
const WINDOWLESS_TURNS = [windowlessTurn(0, 50_000), windowlessTurn(1, 100_000)];

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
    // The window is read off the turns, by the same `readRunContext` call the
    // header gauge makes — the run DTO carries none — so the two surfaces
    // cannot disagree about which turn's window applies.
    expect(html).toContain(agentsFr["run.turnContextShare"]);
    expect(html).toContain(formatWindowPercent(0.25, i18n.language));
    expect(html).toContain(formatWindowPercent(0.5, i18n.language));
  });

  it("normalizes the bars on the window, so the widest is NOT automatically full", () => {
    expect(html).toContain("width:25%");
    expect(html).toContain("width:50%");
    expect(html).not.toContain("width:100%");
  });

  it("shows no fallback notice, and tints the bars with the window accent", () => {
    expect(html).not.toContain(agentsFr["run.turnsPeakRelativeHint"]);
    expect(html).toContain("bg-primary/15");
  });

  it("normalizes on the LAST stated window after a mid-run model swap, as the header does", () => {
    // Swap down 1M → 200k. Against the widest window seen, the two turns would
    // read 90 % and 19 %; against the one in force they read 100 % (clamped)
    // and 95 %. The table follows the header because both call `readRunContext`.
    const swapped = render(
      <RunInfoTab
        run={makeRun()}
        turns={[
          { ...turn(0, 900_000), contextWindow: 1_000_000 },
          { ...turn(1, 190_000), contextWindow: 200_000 },
        ]}
      />,
    );
    expect(swapped).toContain(formatWindowPercent(0.95, i18n.language));
    expect(swapped).not.toContain(formatWindowPercent(0.19, i18n.language));
    expect(swapped).toContain("width:95%");
  });
});

describe("TurnsTable without a context window", () => {
  const html = render(<RunInfoTab run={makeRun()} turns={WINDOWLESS_TURNS} />);

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

  it("says so, instead of silently swapping the denominator under an unchanged header", () => {
    // Without this, a remote-origin run shows a full-width bar on its peak turn
    // under the same `Contexte (tokens)` header a windowed run uses — read as
    // "this turn filled the window", the misreading #1046 removes. The absent
    // `%` column is not a cue: absence never is.
    expect(html).toContain(agentsFr["run.turnsPeakRelativeHint"]);
    // …and in colour too, so the two denominators are not the same picture.
    expect(html).not.toContain("bg-primary/15");
    expect(html).toContain("bg-muted-foreground/15");
  });
});
