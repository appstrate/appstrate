// SPDX-License-Identifier: Apache-2.0

/**
 * The run-scoped documents panel: its per-tile direction badge must read the
 * SAME rule as the run's "produced" list (`runFileDirection`).
 *
 * It did not, twice. Keyed on `runId` alone (`doc.runId === runId`), an upload
 * made FOR the run — committed with that run's id — was badged as something the
 * run had produced. Keyed on `purpose` alone, a file chained in from an EARLIER
 * run (that run's `agent_output`) was. One predicate, two halves, each wrong on
 * a different row shape; the rule itself is exercised in `lib/test/files.test.ts`,
 * and this asserts the tile is wired to it.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import type { FileDto } from "../../hooks/use-files.ts";
import { fileFixture, render } from "../../test/render.tsx";
import { DocumentListPanel } from "../document-list-panel.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const RUN = "run_1";
const EARLIER = "run_0";

/** The badge titles the tile renders (`files:row.{output,input}File`, fr). */
const OUTPUT_BADGE = "Produit en sortie";
const INPUT_BADGE = "Utilisé en entrée";

function file(overrides: Partial<FileDto> & { name: string }): FileDto {
  return fileFixture({ runId: RUN, ...overrides });
}

/** Produced by this run — the only true output. */
const PRODUCED = file({ name: "rapport.md" });
/** Uploaded AS THIS RUN'S INPUT: `user_upload`, anchored to this very run. */
const UPLOADED_FOR_RUN = file({ name: "brief.pdf", purpose: "user_upload", runId: RUN });
/** Chained in with `appfile://`: an earlier run's `agent_output`, our input. */
const CHAINED_IN = file({ name: "source.csv", runId: EARLIER });

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("run document direction badge", () => {
  it("badges only what the run produced as an output", () => {
    // The counts pin BOTH observed bugs at once: keyed on `runId` alone or on
    // `purpose` alone, one of the two consumed files badges as produced and
    // the split reads 2 outputs / 1 input.
    const html = render(
      <DocumentListPanel
        documents={[UPLOADED_FOR_RUN, CHAINED_IN, PRODUCED]}
        isLoading={false}
        error={null}
        empty={{ message: "vide", compact: true }}
        runId={RUN}
        showPurposeTabs={false}
      />,
    );
    expect(count(html, OUTPUT_BADGE)).toBe(1);
    expect(count(html, INPUT_BADGE)).toBe(2);
  });
});
