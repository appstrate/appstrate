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
/** Derived from the locale bundle, never hardcoded — same rule as the `%`. */
const THRESHOLD_LABEL = agentsFr["run.contextGaugeThreshold"].replace("{{tokens}}", "136k");

/**
 * A turn as the runner emits it: the window and the compaction threshold ride
 * the same breadcrumb as the token counts, so the gauge's only input is `turns`.
 */
function turn(index: number, contextTokens: number, over: Partial<RunTurnRow> = {}): RunTurnRow {
  return {
    ...windowlessTurn(index, contextTokens),
    contextWindow: WINDOW,
    compactionThreshold: THRESHOLD,
    ...over,
  };
}

/**
 * A turn stating a window but NO threshold — the key is ABSENT, which is how a
 * runner with auto-compaction disabled reports it.
 */
function thresholdlessTurn(index: number, contextTokens: number): RunTurnRow {
  return { ...windowlessTurn(index, contextTokens), contextWindow: WINDOW };
}

/** A turn from a runner that could not state its window — the key is ABSENT. */
function windowlessTurn(index: number, contextTokens: number): RunTurnRow {
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

/**
 * Class TOKENS, never a substring of the `class` attribute: `overflow-hidden`
 * contains `hidden`, so `expect(cls).not.toContain("hidden")` passes and fails
 * for the wrong reasons. Splitting first makes "is this utility applied?" an
 * exact question — which matters here, since the responsive contract under test
 * is precisely `hidden` vs `w-0`.
 */
function classesOf(html: string, pattern: RegExp): string[] {
  return (pattern.exec(html)?.[1] ?? "").split(/\s+/).filter(Boolean);
}

describe("ContextGaugeReadout — active run", () => {
  const html = render(<ContextGaugeReadout turns={TURNS} status="running" />);

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

  it("carries the threshold in the accessible value, not only in a mouse-only `title`", () => {
    // `title` reaches a precise mouse and nothing else — no screen reader, no
    // touch. The threshold is the stated point of the terminal reading, so it
    // rides on `aria-valuetext`, which every AT surfaces with the progressbar.
    expect(html).toContain(THRESHOLD_LABEL);
    const valueText = /aria-valuetext="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(valueText).toContain(THRESHOLD_LABEL);
    expect(valueText).toContain((128_000).toLocaleString(i18n.language));
  });

  it("gives the threshold marker a hit area wider than one pixel", () => {
    const marker = classesOf(html, /title="[^"]*"\s+class="([^"]*)"/);
    expect(marker.length).toBeGreaterThan(0);
    // A transparent 8px target centred on the threshold; the visible mark inside
    // it stays thin so it still reads as a line and not as a second fill.
    expect(marker).toContain("w-2");
    expect(marker).toContain("-translate-x-1/2");
    expect(marker).not.toContain("w-px");
  });
});

describe("ContextGaugeReadout — count past a stale window", () => {
  // The window is what the runner stated for the turn; a provider can bill a
  // prompt larger than it. `readRunContext` leaves that raw count unclamped.
  const html = render(
    <ContextGaugeReadout turns={[thresholdlessTurn(0, 210_000)]} status="running" />,
  );

  it("clamps `aria-valuenow` into the declared range", () => {
    // `valuenow > valuemax` makes AT announce a broken widget, not a full one.
    expect(html).toContain('aria-valuemax="200000"');
    expect(html).toContain('aria-valuenow="200000"');
    expect(html).not.toContain('aria-valuenow="210000"');
  });

  it("still reports the honest raw figure, in the text and in `aria-valuetext`", () => {
    expect(html).toContain("210k / 200k");
    const valueText = /aria-valuetext="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(valueText).toContain((210_000).toLocaleString(i18n.language));
  });
});

describe("ContextGaugeReadout — 375px header budget", () => {
  // The header row also carries a 5-tab list, the `$` pill and Re-run/Cancel.
  // The gauge must not be what pushes the page into a horizontal scroll.
  const html = render(<ContextGaugeReadout turns={TURNS} status="running" />);

  const BAR = /role="progressbar"[\s\S]*?class="([^"]*)"/;

  it("never compresses, so the counts cannot be squeezed into an unreadable width", () => {
    expect(classesOf(html, /^<div class="([^"]*)"/)).toContain("shrink-0");
  });

  it("keeps the counts at every width — they ARE the reading", () => {
    const counts = classesOf(html, /<span class="([^"]*)">128k \/ 200k<\/span>/);
    expect(counts.length).toBeGreaterThan(0);
    expect(counts).not.toContain("hidden");
  });

  it("drops only what the counts already say: the bar and the derived percentage", () => {
    const bar = classesOf(html, BAR);
    expect(bar).toContain("w-0");
    expect(bar).toContain("sm:w-14");
    expect(bar).not.toContain("w-14");

    const percent = classesOf(html, /<span class="([^"]*)">·/);
    expect(percent).toContain("hidden");
    expect(percent).toContain("sm:inline");
  });

  it("collapses the track's WIDTH rather than `display: none`-ing it away", () => {
    // `hidden` would take the progressbar out of the accessibility tree, and
    // with it the `aria-valuetext` that is the only carrier of the compaction
    // threshold for a screen-reader or touch user — dropping the threshold for
    // precisely the people the marker fix exists for.
    const bar = classesOf(html, BAR);
    expect(bar).not.toContain("hidden");
    expect(bar).toContain("block");
    // …and the threshold is still announced at that width.
    expect(/aria-valuetext="([^"]*)"/.exec(html)?.[1] ?? "").toContain(THRESHOLD_LABEL);
  });
});

describe("ContextGaugeReadout — terminal run", () => {
  const html = render(<ContextGaugeReadout turns={TURNS} status="success" />);

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

describe("ContextGaugeReadout — window and threshold ride the turns", () => {
  it("takes its denominator from the turns, with no run-level field to override it", () => {
    // 1M window: nothing outside `turns` could have supplied it.
    const html = render(
      <ContextGaugeReadout
        turns={[turn(0, 128_000, { contextWindow: 1_000_000, compactionThreshold: 800_000 })]}
        status="running"
      />,
    );
    expect(html).toContain("128k / 1.0M");
    expect(html).toContain('aria-valuemax="1000000"');
    expect(html).toContain("width:12.8%");
    expect(html).toContain("left:80%");
  });

  it("omits the marker but keeps the gauge when the payload carries no threshold", () => {
    // Auto-compaction disabled, now reportable: the key is absent, not zero.
    const html = render(
      <ContextGaugeReadout
        turns={[thresholdlessTurn(0, 40_000), thresholdlessTurn(1, 128_000)]}
        status="running"
      />,
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("128k / 200k");
    expect(html).not.toContain("left:");
    expect(html).not.toContain(THRESHOLD_LABEL);
  });

  it("sizes the reading against the LAST stated window after a mid-run model swap", () => {
    // Swap down 1M → 200k. Sizing `current` against the widest window seen
    // would print 19 % for a context one turn from compaction.
    const html = render(
      <ContextGaugeReadout
        turns={[
          turn(0, 900_000, { contextWindow: 1_000_000, compactionThreshold: 800_000 }),
          turn(1, 190_000),
        ]}
        status="running"
      />,
    );
    expect(html).toContain("190k / 200k");
    expect(html).toContain('aria-valuemax="200000"');
    expect(html).toContain(formatWindowPercent(0.95, i18n.language));
    expect(html).not.toContain(formatWindowPercent(0.19, i18n.language));
  });
});

describe("ContextGaugeReadout — nothing to render", () => {
  // Every case must degrade to "no gauge, `$` alone" — the failure mode guarded
  // against is a bar rendered at zero width, which reads as "context is empty"
  // on a run whose context is simply unknown.
  //
  // `toBe("")` is the whole assertion, and deliberately so: it SUBSUMES every
  // "no progressbar / no width:0% / no `ctx` label" check, so listing those
  // beside it adds assertions that cannot fail independently — coverage in
  // appearance only. The contract under test is literally "emits nothing"; a
  // weaker set of checks would let a non-empty-but-gauge-less render pass, and
  // that is not the contract `ContextGaugeReadout` documents (it returns `null`).
  function assertNoGauge(html: string) {
    expect(html).toBe("");
  }

  it("renders nothing for a run predating the turn breadcrumb", () => {
    assertNoGauge(render(<ContextGaugeReadout turns={[]} status="success" />));
  });

  it("renders nothing when no turn states a window, even with real counts", () => {
    // Runs predating the field, and runners that cannot size their model. There
    // is no run-level fallback left: the turns are the ONLY source of the
    // denominator, so a series that states none drops the gauge whole.
    assertNoGauge(
      render(
        <ContextGaugeReadout
          turns={[windowlessTurn(0, 40_000), windowlessTurn(1, 128_000)]}
          status="running"
        />,
      ),
    );
  });

  it("renders nothing when every turn reported a zero context", () => {
    // Not a hypothetical: a provider that bills completion tokens but omits the
    // prompt count settles real turns whose context reads zero. The old code
    // rendered `ctx 0 / 200k · 0 %` for them — the exact lie above.
    assertNoGauge(
      render(<ContextGaugeReadout turns={[turn(0, 0), turn(1, 0)]} status="success" />),
    );
  });
});
