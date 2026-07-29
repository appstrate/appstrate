// SPDX-License-Identifier: Apache-2.0

/**
 * `ContextGaugeReadout` rendering tests (#1046).
 *
 * Same harness as `run-row.test.tsx`: no DOM, so the component is rendered with
 * `renderToStaticMarkup` and asserted on its HTML, through the SPA's own i18n
 * singleton so the locale under test is the locale the assertions use.
 */

import type { ReactElement } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import agentsFr from "../../locales/fr/agents.json";
import i18n, { i18nReady } from "../../i18n.ts";
import type { RunTurnRow } from "../log-utils.ts";
import { formatWindowPercent } from "../run-context.ts";
import { ContextGaugeReadout } from "../run-context-gauge.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const WINDOW = 200_000;
const THRESHOLD = 136_000;

function turn(index: number, contextTokens: number): RunTurnRow {
  return {
    index,
    contextTokens,
    inputTokens: contextTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** Peaks at 187k, then compacts down to 128k — both readings are non-trivial. */
const TURNS = [turn(0, 40_000), turn(1, 187_000), turn(2, 128_000)];

function render(node: ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

describe("ContextGaugeReadout — active run", () => {
  const html = render(
    <ContextGaugeReadout
      turns={TURNS}
      contextWindow={WINDOW}
      compactionThreshold={THRESHOLD}
      status="running"
    />,
  );

  it("shows the CURRENT context (the last turn), not the peak", () => {
    expect(html).toContain("128k / 200k");
    expect(html).not.toContain("187k");
  });

  it("labels it `ctx` and appends the share of the window", () => {
    expect(html).toContain(agentsFr["run.contextGaugeLabel"]);
    expect(html).not.toContain(agentsFr["run.contextGaugePeakLabel"]);
    // Derived, never hardcoded: `Intl` spacing before `%` is locale/ICU bound.
    expect(html).toContain(formatWindowPercent(0.64, i18n.language));
  });

  it("exposes the bar as a progressbar carrying the same numbers as the text", () => {
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="128000"');
    expect(html).toContain('aria-valuemax="200000"');
    expect(html).toContain(`aria-label="${agentsFr["run.contextGaugeAria"]}"`);
    expect(html).toContain("width:64%");
  });

  it("marks the compaction threshold on the track", () => {
    expect(html).toContain("left:68%");
  });
});

describe("ContextGaugeReadout — terminal run", () => {
  const html = render(
    <ContextGaugeReadout
      turns={TURNS}
      contextWindow={WINDOW}
      compactionThreshold={THRESHOLD}
      status="success"
    />,
  );

  it("switches to the PEAK reading, labelled `pic ctx`", () => {
    expect(html).toContain(agentsFr["run.contextGaugePeakLabel"]);
    expect(html).toContain("187k / 200k");
    expect(html).not.toContain("128k");
    expect(html).toContain('aria-valuenow="187000"');
  });

  it("drops the percentage — a peak share is a diagnostic, the counts carry it", () => {
    expect(html).not.toContain(formatWindowPercent(0.935, i18n.language));
    expect(html).not.toContain("%<");
  });
});

describe("ContextGaugeReadout — threshold absent", () => {
  it("omits the marker but keeps the gauge", () => {
    const html = render(
      <ContextGaugeReadout
        turns={TURNS}
        contextWindow={WINDOW}
        compactionThreshold={null}
        status="running"
      />,
    );
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain("left:");
  });
});

describe("ContextGaugeReadout — nothing to render", () => {
  // Both cases must degrade to "no gauge, `$` alone". Asserting the component
  // emitted nothing is not enough on its own — the failure mode this guards
  // against is a bar rendered at zero width, which reads as "context is empty"
  // on a run whose context is simply unknown.
  function assertNoZeroedBar(html: string) {
    expect(html).toBe("");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("width:0%");
    expect(html).not.toContain("0 / ");
    expect(html).not.toContain(agentsFr["run.contextGaugeLabel"]);
    expect(html).not.toContain(agentsFr["run.contextGaugePeakLabel"]);
  }

  it("renders nothing for a run predating the turn breadcrumb", () => {
    assertNoZeroedBar(
      render(
        <ContextGaugeReadout
          turns={[]}
          contextWindow={WINDOW}
          compactionThreshold={THRESHOLD}
          status="success"
        />,
      ),
    );
  });

  it("renders nothing when the window is unknown, even with real turns", () => {
    assertNoZeroedBar(
      render(
        <ContextGaugeReadout
          turns={TURNS}
          contextWindow={null}
          compactionThreshold={null}
          status="running"
        />,
      ),
    );
  });
});
