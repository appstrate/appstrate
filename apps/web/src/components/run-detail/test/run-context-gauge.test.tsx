// SPDX-License-Identifier: Apache-2.0

/**
 * What `ContextGaugeReadout` does with a reading: the current context while
 * the run is active, the peak once it settled, and nothing without a truthful
 * reading. The reading itself is `run-context.test.ts`'s.
 */

import { describe, it, expect } from "bun:test";
import agentsFr from "../../../locales/fr/agents.json";
import i18n, { i18nReady } from "../../../i18n.ts";
import type { RunTurnRow } from "../../log-utils.ts";
import { formatWindowPercent } from "@appstrate/ui/context-window";
import { render } from "../../../test/render.tsx";
import { ContextGaugePeakHint, ContextGaugeReadout } from "../run-context-gauge.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

function turn(index: number, contextTokens: number, contextWindow?: number): RunTurnRow {
  return {
    index,
    contextTokens,
    inputTokens: contextTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/** Peaks at 187k, then compacts down to 128k. */
const TURNS = [turn(0, 40_000, 200_000), turn(1, 187_000, 200_000), turn(2, 128_000, 200_000)];

const nbsp = "\u00a0";
const text = (html: string) => html.replace(/<[^>]*>/g, "");
const valueText = (html: string) => /aria-valuetext="([^"]*)"/.exec(html)?.[1] ?? "";

describe("ContextGaugeReadout", () => {
  it("shows the current context and its share while the run is active", () => {
    const html = render(<ContextGaugeReadout turns={TURNS} status="running" />);
    expect(text(html)).toBe(
      `128${nbsp}k / 200${nbsp}k · ${formatWindowPercent(0.64, i18n.language)}`,
    );
    expect(html).toContain('aria-valuenow="128000"');
    expect(html).not.toContain("tabindex");
  });

  it("shows the peak once the run settled, and says so", () => {
    const html = render(<ContextGaugeReadout turns={TURNS} status="success" />);
    expect(text(html)).toBe(`187${nbsp}k / 200${nbsp}k`);
    expect(valueText(html)).toContain("pic atteint");
    expect(html).toContain('tabindex="0"');
    expect(text(render(<ContextGaugePeakHint />))).toBe(agentsFr["run.contextGaugePeakHint"]);
  });

  it("marks an assumed window and says why, in the value text and a hint", () => {
    const assumed = [{ ...turn(0, 64_000, 128_000), contextWindowAssumed: true as const }];
    const html = render(<ContextGaugeReadout turns={assumed} status="running" />);
    expect(text(html)).toBe(
      `64${nbsp}k / ≈${nbsp}128${nbsp}k · ${formatWindowPercent(0.5, i18n.language)}`,
    );
    expect(valueText(html)).toContain("Fenêtre supposée");
    expect(html).toContain('tabindex="0"');
  });

  it("clamps the bar's value past a stale window, keeping the raw count in the text", () => {
    const html = render(
      <ContextGaugeReadout turns={[turn(0, 210_000, 200_000)]} status="running" />,
    );
    expect(html).toContain('aria-valuenow="200000"');
    expect(text(html)).toContain(`210${nbsp}k / 200${nbsp}k`);
  });

  it("renders nothing without a window or a measured turn", () => {
    expect(render(<ContextGaugeReadout turns={[]} status="success" />)).toBe("");
    expect(render(<ContextGaugeReadout turns={[turn(0, 128_000)]} status="running" />)).toBe("");
    expect(render(<ContextGaugeReadout turns={[turn(0, 0, 200_000)]} status="success" />)).toBe("");
  });
});
