// SPDX-License-Identifier: Apache-2.0

/**
 * The run-scoped files panel: its per-tile direction badge and its filter strip
 * must read the SAME rule.
 *
 * They did not. The badge was an inline fourth copy of the predicate keyed on
 * `run_id` alone (`file.run_id === runId ? "output" : "input"`), so an upload
 * made FOR the run — committed with that run's id — was badged as something the
 * run had produced. The Fichiers tab filtered on `purpose` alone, the mirror
 * half, so a file chained in from an EARLIER run (that run's `agent_output`)
 * was listed under "produced". One panel, two halves of one predicate, each
 * wrong on a different row shape. Both now go through `runFileDirection`.
 *
 * Same no-DOM harness as `run-outcome-tab.test.tsx` (this repo has no jsdom):
 * `renderToStaticMarkup`, plus the `QueryClientProvider` `FileListPanel` needs
 * to wire its delete/keep mutations on mount.
 */

import type { ReactElement } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n, { i18nReady } from "../../i18n.ts";
import type { FileDto } from "../../hooks/use-files.ts";
import { FileListPanel, type DirectionFilter } from "../file-list-panel.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const RUN = "run_1";
const EARLIER = "run_0";

/** The badge titles the tile renders (`files:row.{output,input}File`, fr). */
const OUTPUT_BADGE = "Produit en sortie";
const INPUT_BADGE = "Utilisé en entrée";

function file(overrides: Partial<FileDto> & { name: string }): FileDto {
  return {
    id: `file_${overrides.name}`,
    purpose: "agent_output",
    run_id: RUN,
    packageId: "@acme/reporter",
    mime: "text/plain",
    size: 12,
    createdAt: "2026-07-01T10:00:00.000Z",
    expiresAt: null,
    capabilities: { download: true, delete: false, keep: false },
    ...overrides,
  } as unknown as FileDto;
}

/** Produced by this run — the only true output. */
const PRODUCED = file({ name: "rapport.md" });
/** Uploaded AS THIS RUN'S INPUT: `user_upload`, anchored to this very run. */
const UPLOADED_FOR_RUN = file({ name: "brief.pdf", purpose: "user_upload", run_id: RUN });
/** Chained in with `appfile://`: an earlier run's `agent_output`, our input. */
const CHAINED_IN = file({ name: "source.csv", run_id: EARLIER });

const ALL = [UPLOADED_FOR_RUN, CHAINED_IN, PRODUCED];

function render(node: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>{node}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Exactly what the run Files tab renders: the run's whole page of files plus
 * the selected direction. The panel resolves the filter AND the badges, so this
 * drives the real path rather than a reimplementation of it.
 */
function panel(value: DirectionFilter, files: FileDto[] = ALL): string {
  return render(
    <FileListPanel
      files={files}
      isLoading={false}
      error={null}
      filter={{ axis: "direction", value, onChange: () => {} }}
      empty={{ message: "vide", compact: true }}
      runId={RUN}
    />,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("run file direction badge", () => {
  it("badges only what the run produced as an output", () => {
    const html = panel("all");
    expect(count(html, OUTPUT_BADGE)).toBe(1);
    expect(count(html, INPUT_BADGE)).toBe(2);
  });

  it("badges an upload made FOR this run as an input, not an output", () => {
    // The observed bug: `purpose: "user_upload"` + this run's id. Keyed on
    // `run_id` alone, a run with one input and one output badged BOTH produced.
    const html = panel("all", [UPLOADED_FOR_RUN]);
    expect(html).toContain(INPUT_BADGE);
    expect(html).not.toContain(OUTPUT_BADGE);
  });

  it("badges a file chained in from an earlier run as an input", () => {
    const html = panel("all", [CHAINED_IN]);
    expect(html).toContain(INPUT_BADGE);
    expect(html).not.toContain(OUTPUT_BADGE);
  });
});

describe("run file direction filter", () => {
  it("labels the strip by direction, not by storage purpose", () => {
    const html = panel("all");
    expect(html).toContain("Tous");
    expect(html).toContain("Produits");
    expect(html).toContain("Importés");
    // The gallery's purpose vocabulary has no business on a run page.
    expect(html).not.toContain("Produits par les agents");
    // A missing flat dotted key renders as the key string itself.
    expect(html).not.toContain("filter.");
  });

  it("keeps only the produced file under 'produits', and badges it as such", () => {
    const html = panel("output");
    expect(html).toContain("rapport.md");
    expect(html).not.toContain("brief.pdf");
    // The mirror bug: filtering on `purpose` alone kept the chained-in file.
    expect(html).not.toContain("source.csv");
    expect(count(html, OUTPUT_BADGE)).toBe(1);
    expect(count(html, INPUT_BADGE)).toBe(0);
  });

  it("keeps both consumed files under 'importés', and badges neither as output", () => {
    const html = panel("input");
    expect(html).toContain("brief.pdf");
    expect(html).toContain("source.csv");
    expect(html).not.toContain("rapport.md");
    expect(count(html, INPUT_BADGE)).toBe(2);
    expect(count(html, OUTPUT_BADGE)).toBe(0);
  });

  it("agrees with the badge on every row of the same fixture", () => {
    // The invariant the split predicate broke: whatever a tab selects, every
    // tile it shows carries that tab's badge — and the two tabs partition the
    // unfiltered list exactly.
    const outputs = panel("output");
    const inputs = panel("input");
    expect(count(outputs, INPUT_BADGE)).toBe(0);
    expect(count(inputs, OUTPUT_BADGE)).toBe(0);
    expect(count(outputs, OUTPUT_BADGE) + count(inputs, INPUT_BADGE)).toBe(ALL.length);
  });
});
