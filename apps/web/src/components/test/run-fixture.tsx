// SPDX-License-Identifier: Apache-2.0

/**
 * The run fixture and the render harness the run surfaces' tests share.
 *
 * The web test runner has NO DOM, so components are rendered with
 * `renderToStaticMarkup` and asserted on their HTML. That is enough for what
 * these suites are about — which facts a surface emits — and it needs no new
 * dependency: `react-dom`, `react-router-dom` and `i18next` are already SPA
 * deps.
 *
 * Shared rather than copied per file because three suites now render the same
 * run through three different surfaces (the table row, the detail strip, the
 * duration leaf), and a fixture that drifts between them makes "the table shows
 * it, the strip does not" impossible to trust.
 */

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import i18n, { i18nReady } from "../../i18n.ts";

// The SPA's own i18n instance, not a hand-rolled one: `formatDateField` reads
// `i18n.language` off this singleton, so a private instance would render dates
// under whatever locale the runner happened to default to while the assertions
// used another. Pin the language rather than trusting the ambient default.
await i18nReady;
await i18n.changeLanguage("fr");

export const STARTED_AT = "2026-07-01T10:00:00.000Z";

export function render(node: ReactElement): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>{node}</MemoryRouter>
    </I18nextProvider>,
  );
}

/** A terminal run carrying every field a run surface can display. */
export function makeRun(overrides: Partial<EnrichedRun> = {}): EnrichedRun {
  return {
    id: "run_1",
    runNumber: 42,
    status: "success",
    packageId: "@acme/reporter",
    started_at: STARTED_AT,
    duration: 4200,
    error: null,
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
