// SPDX-License-Identifier: Apache-2.0

/**
 * `ContextGaugeReadout` rendering tests (#1046).
 *
 * Same harness as `run-detail-row.test.tsx`: no DOM, so the component is rendered with
 * `renderToStaticMarkup` and asserted on its HTML, through the SPA's own i18n
 * singleton so the locale under test is the locale the assertions use.
 *
 * The reading ITSELF (current vs peak, which window wins, what makes a turn
 * unusable) is `run-context.test.ts`'s job. What is under test here is only what
 * the component does with a reading: which one it picks per status, and how it
 * renders into text, ARIA and responsive classes.
 */

import type { ReactElement } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import agentsFr from "../../locales/fr/agents.json";
import i18n, { i18nReady } from "../../i18n.ts";
import type { RunTurnRow } from "../log-utils.ts";
import { formatWindowPercent } from "../run-context.ts";
import { ContextGaugeReadout, ContextGaugePeakHint } from "../run-context-gauge.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const WINDOW = 200_000;

/** A turn as the runner emits it: the window rides the same breadcrumb. */
function turn(index: number, contextTokens: number, over: Partial<RunTurnRow> = {}): RunTurnRow {
  return { ...windowlessTurn(index, contextTokens), contextWindow: WINDOW, ...over };
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
 * contains `hidden`, so a `not.toContain("hidden")` would pass and fail for the
 * wrong reasons — and `hidden` vs `w-0` is precisely the contract under test.
 */
function classesOf(html: string, pattern: RegExp): string[] {
  return (pattern.exec(html)?.[1] ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Undo React's SSR escaping — it emits `&#x27;` for the apostrophe in
 * `l'exécution`. React escapes exactly these five characters, so this is a
 * complete inverse, not a best-effort one.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Everything a sighted user reads off the pill, tags stripped. Asserting the
 * WHOLE visible string is what pins down that the `ctx` / `pic ctx` prefix is
 * gone: a `not.toContain("ctx")` would be satisfied by a render that grew some
 * other label, and would break on any future copy containing those letters.
 */
function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""));
}

/** The progressbar's `aria-valuetext` — the only carrier of the exact counts. */
function valueTextOf(html: string): string {
  return decodeEntities(/aria-valuetext="([^"]*)"/.exec(html)?.[1] ?? "");
}

/**
 * The value text the component SHOULD emit, through the same i18n singleton the
 * component uses. Not a re-implementation: what is under test is WHICH of the
 * two keys a state picks, so the assertions below compare against both.
 */
function expectedValueText(key: string, used: number): string {
  return i18n.t(key, {
    ns: "agents",
    used: used.toLocaleString(i18n.language),
    window: WINDOW.toLocaleString(i18n.language),
  });
}

describe("ContextGaugeReadout — active run", () => {
  const html = render(<ContextGaugeReadout turns={TURNS} status="running" />);

  it("shows the CURRENT context and nothing else — no peak, no text label", () => {
    // Derived, never hardcoded: `Intl` spacing before `%` is locale/ICU bound.
    expect(visibleText(html)).toBe(`128k / 200k· ${formatWindowPercent(0.64, i18n.language)}`);
    expect(html).not.toContain("187k");
  });

  it("names the reading as the CURRENT context in the accessible value", () => {
    // The visible `ctx` prefix is gone, so this is the assistive-tech carrier of
    // the distinction. The `not.toBe` is not redundant with the `toBe`: it fails
    // if the two locale strings are ever edited into each other, which would
    // erase the distinction while every other assertion still passed.
    expect(valueTextOf(html)).toBe(expectedValueText("run.contextGaugeValueText", 128_000));
    expect(valueTextOf(html)).not.toBe(expectedValueText("run.contextGaugePeakValueText", 128_000));
  });

  it("adds no tooltip: a live reading is the unsurprising one", () => {
    // The only focusable thing this component ever renders is the peak tooltip's
    // trigger, so its absence is the assertion.
    expect(html).not.toContain("tabindex");
  });

  it("exposes the bar as a progressbar carrying the same numbers as the text", () => {
    // Also the only place the turn-stated window is proven to reach the DOM:
    // nothing but `turns` could have supplied the 200000 below.
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="128000"');
    expect(html).toContain('aria-valuemax="200000"');
    expect(html).toContain(`aria-label="${agentsFr["run.contextGaugeAria"]}"`);
    expect(html).toContain("width:64%");
  });
});

describe("ContextGaugeReadout — count past a stale window", () => {
  // The window is what the runner stated for the turn; a provider can bill a
  // prompt larger than it. `readRunContext` leaves that raw count unclamped.
  const html = render(<ContextGaugeReadout turns={[turn(0, 210_000)]} status="running" />);

  it("clamps `aria-valuenow` into the declared range while the text stays honest", () => {
    // `valuenow > valuemax` makes AT announce a broken widget, not a full one.
    expect(html).toContain('aria-valuemax="200000"');
    expect(html).toContain('aria-valuenow="200000"');
    expect(html).not.toContain('aria-valuenow="210000"');
    expect(html).toContain("210k / 200k");
    expect(valueTextOf(html)).toContain((210_000).toLocaleString(i18n.language));
  });
});

describe("ContextGaugeReadout — 375px header budget", () => {
  // The header row also carries a 5-tab list, the `$` pill and Re-run/Cancel.
  // The gauge must not be what pushes the page into a horizontal scroll.
  const html = render(<ContextGaugeReadout turns={TURNS} status="running" />);

  const BAR = /role="progressbar"[\s\S]*?class="([^"]*)"/;

  it("never compresses, and keeps the counts at every width — they ARE the reading", () => {
    expect(classesOf(html, /^<div class="([^"]*)"/)).toContain("shrink-0");
    const counts = classesOf(html, /<span class="([^"]*)">128k \/ 200k<\/span>/);
    expect(counts.length).toBeGreaterThan(0);
    expect(counts).not.toContain("hidden");
  });

  it("drops the bar and the percentage, collapsing the track's WIDTH not its display", () => {
    // `hidden` would take the progressbar out of the accessibility tree, and
    // with it the `aria-valuetext` that is the only carrier of the
    // unabbreviated counts for a screen-reader or touch user.
    const bar = classesOf(html, BAR);
    expect(bar).toContain("w-0");
    expect(bar).toContain("sm:w-14");
    expect(bar).not.toContain("w-14");
    expect(bar).not.toContain("hidden");
    expect(bar).toContain("block");

    const percent = classesOf(html, /<span class="([^"]*)">·/);
    expect(percent).toContain("hidden");
    expect(percent).toContain("sm:inline");
  });
});

describe("ContextGaugeReadout — terminal run", () => {
  const html = render(<ContextGaugeReadout turns={TURNS} status="success" />);

  it("switches to the PEAK reading and drops the percentage with it", () => {
    // A peak share is a diagnostic; the two absolute figures already carry it.
    // Exact equality is what proves the percentage is gone — and that the
    // `pic ctx` prefix did not come back in its place.
    expect(visibleText(html)).toBe("187k / 200k");
    expect(html).toContain('aria-valuenow="187000"');
    expect(html).not.toContain("128k");
  });

  it("names it as the PEAK in the accessible value, not the current context", () => {
    expect(valueTextOf(html)).toBe(expectedValueText("run.contextGaugePeakValueText", 187_000));
    expect(valueTextOf(html)).not.toBe(expectedValueText("run.contextGaugeValueText", 187_000));
  });

  it("gives sighted users the same fact through a keyboard-reachable tooltip", () => {
    // `title=` would be invisible to touch and to screen readers; the house
    // pattern (`run-tokens-readout.tsx`) is a Radix tooltip on a `tabIndex={0}`
    // trigger, and the trigger is what makes the peak wording reachable at all.
    expect(html).toContain('tabindex="0"');
    const trigger = /<span tabindex="0" class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(trigger.split(/\s+/)).toContain("decoration-dotted");

    // Radix keeps the content unmounted until opened and this runner has no DOM,
    // so the wording is asserted on the exported content subcomponent — the same
    // affordance `run-detail-row.test.tsx` uses for `RunDetailPanel`.
    expect(visibleText(render(<ContextGaugePeakHint />))).toBe(
      agentsFr["run.contextGaugePeakHint"],
    );
  });
});

describe("ContextGaugeReadout — nothing to render", () => {
  // Every case must degrade to "no gauge, `$` alone". `toBe("")` SUBSUMES every
  // "no progressbar / no width:0% / no counts" check, so listing those beside it
  // would add assertions that cannot fail independently. The contract is
  // literally "emits nothing" — the component returns `null`.

  it("renders nothing for a run predating the turn breadcrumb", () => {
    expect(render(<ContextGaugeReadout turns={[]} status="success" />)).toBe("");
  });

  it("renders nothing when no turn states a window, even with real counts", () => {
    // Runs predating the field, and runners that cannot size their model. The
    // turns are the ONLY source of the denominator, so a series that states none
    // drops the gauge whole rather than rendering an uninterpretable count.
    expect(
      render(
        <ContextGaugeReadout
          turns={[windowlessTurn(0, 40_000), windowlessTurn(1, 128_000)]}
          status="running"
        />,
      ),
    ).toBe("");
  });

  it("renders nothing when every turn reported a zero context", () => {
    // Not a hypothetical: a provider that bills completion tokens but omits the
    // prompt count settles real turns whose context reads zero. The old code
    // rendered `ctx 0 / 200k · 0 %` for them — the exact lie above.
    expect(render(<ContextGaugeReadout turns={[turn(0, 0), turn(1, 0)]} status="success" />)).toBe(
      "",
    );
  });
});
